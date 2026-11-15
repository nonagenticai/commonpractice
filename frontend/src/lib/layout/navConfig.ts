// src/lib/layout/navConfig.ts — single source for sidebar nav, shared by the
// Sidebar component and (1:1) the route stubs. SVG inner markup is ported from
// demo.html so icons match. Each `id` maps to a screen; `href` is its route.
//
// Navigation is driven by the user's REAL realm role (no demo persona switcher):
// the Sidebar renders every group the role permits, all at once. Group → minimum
// role: discover = any authenticated user · operate = NO group gate (per-item, see
// below) · administer = tenant_admin (with super_admin-only items gated per-item).
//
// P0 REGRESSION (fixed): `operate` used to carry a blanket group-level
// `requiresRole: 'super_admin'` and not one of its 11 items carried its own gate.
// The backend never agreed with that: Datasets / Connectors / Ontology all read via
// `resolveTenant` (ANY member of the tenant) and Blocks reads via bare `validateAuth`.
// The effect was that a real customer's tenant_admin signed in and could not reach
// Datasets or Ontology — the two screens that make the flow builder do anything with
// their OWN data — while the API would have served them happily. It was invisible in
// testing because the test identity (fr-test) is super_admin, which passes every gate.
// The rule now: an item's gate is the guard on the route it needs to RENDER (its
// primary read), NOT its most privileged action. Read-only visitors are normal — those
// screens already disable their write controls from the server's own `canManage` flag
// (datasets/connectors/ontology all return it; block-edit derives canEdit/canDelete).

/** Realm-role gate for a nav group or item. Mirrors auth.svelte.ts getters. */
export type RoleGate = 'super_admin' | 'tenant_admin' | 'developer';

/** Sidebar nav groups, in render order. */
export type NavGroup = 'discover' | 'operate' | 'administer';

export interface NavItem {
	id: string;
	/** Paraglide message key resolved at render time (§5B) — see Sidebar. */
	labelKey: string;
	href: string;
	group: NavGroup;
	/** Finer per-item gate ON TOP of the group gate. `super_admin` → platform-only
	 *  (all-tenants); `tenant_admin` → own-tenant admin screens; `developer` → tenant
	 *  authoring screens. All three are COMPOSITE in the same direction the backend's
	 *  `admin-guards.ts` defines them (super_admin ⊃ tenant_admin ⊃ developer), so a
	 *  weaker gate never hides a screen from a stronger role. Items without this are
	 *  open to any authenticated user — which is the correct mirror of a route guarded
	 *  only by `validateAuth` / `resolveTenant`. Visibility is gated on the ROLE, never
	 *  on tenant (SPEC-PHASE4 Part 7). */
	requiresRole?: RoleGate;
	/** A live count badge, keyed into auth.user.counts and coloured here. The Sidebar
	 *  resolves the number at render time (the old hardcoded demo text is gone). */
	badge?: { countKey: 'challenges' | 'solutions' | 'sandboxes' | 'requests'; color?: string };
	/** Inner SVG markup (paths) rendered inside a 24×24 stroked <svg>. */
	icon: string;
	/** WHERE the item renders (W2 nav declutter, 2026-10-14). `group` above is the screen's
	 *  conceptual AREA (it still drives page eyebrows and the catalog guards); `placement` is where
	 *  the chrome offers it:
	 *  - `main`     — the top of the sidebar, always visible (Home, Challenges, Solutions, Build, Results);
	 *  - `library`  — the "Library" sidebar group, collapsed by default;
	 *  - `settings` — not in the sidebar at all: the gear → /settings index + sub-nav;
	 *  - `none`     — reachable, but offered elsewhere (Submit = a primary button on Home and
	 *                 /challenges; Getting started = the topbar "?"; New block = a button on /blocks).
	 *  The role gate is unchanged by placement: `canReachNav` still reads every item. */
	placement: NavPlacement;
	/** ⚑ CYCLE HOOK. The item only makes sense while the voting cycle runs (Results = the weekly
	 *  winner). `sidebarNav(roles, { cycleOn: false })` drops it. WHERE `cycleOn` comes from is
	 *  `cycle-nav.ts` (`cycleOnFor(/api/me cycleCadence)`); this file deliberately implements no cycle logic. */
	requiresCycle?: true;
}

/** Where a nav item is offered — see `NavItem.placement`. */
export type NavPlacement = 'main' | 'library' | 'settings' | 'none';

export interface NavGroupDef {
	group: NavGroup;
	/** Paraglide message key for the group heading. */
	labelKey: string;
	/** Minimum role to see the group at all (undefined = any authenticated user). */
	requiresRole?: RoleGate;
}

/** Groups in render order, each with its heading key + minimum role. */
export const NAV_GROUPS: NavGroupDef[] = [
	{ group: 'discover', labelKey: 'nav_group_discover' },
	// `operate` deliberately has NO group gate: its 11 items span the whole backend
	// spectrum (bare validateAuth → resolveTenant → isDeveloper → requireSuperAdmin),
	// so a single group minimum could only be wrong in one direction or the other. A
	// blanket super_admin gate is what caused the tenant_admin lockout; the gates now
	// live per-item. The Sidebar drops a group whose visible-item list is empty, so a
	// role that qualifies for none of them still never sees a stray heading.
	{ group: 'operate', labelKey: 'nav_group_operate' },
	{ group: 'administer', labelKey: 'nav_group_administer', requiresRole: 'tenant_admin' }
];

export const NAV_ITEMS: NavItem[] = [
	// ---- Discover (any authenticated user) ----
	{ id: 'home', labelKey: 'nav_home', href: '/', group: 'discover', placement: 'main',
		icon: '<path d="M3 12L12 3l9 9"/><path d="M5 10v10h14V10"/>' },
	{ id: 'challenges', labelKey: 'nav_challenges', href: '/challenges', group: 'discover', placement: 'main',
		badge: { countKey: 'challenges' },
		icon: '<circle cx="12" cy="8" r="6"/><path d="M9 14l-2 7 5-3 5 3-2-7"/>' },
	{ id: 'submit', labelKey: 'nav_submit', href: '/submit', group: 'discover', placement: 'none',
		icon: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>' },
	{ id: 'solutions', labelKey: 'nav_solutions', href: '/solutions', group: 'discover', placement: 'main',
		badge: { countKey: 'solutions', color: 'var(--c-coral-mid)' },
		icon: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>' },
	{ id: 'build', labelKey: 'nav_build', href: '/build', group: 'discover', placement: 'main',
		icon: '<path d="M14 6l8 8-2 2-8-8 2-2z"/><path d="M9 11L4 16l4 4 5-5"/><path d="M9 3l3 3M16 14l3 3"/>' },
	{ id: 'winner', labelKey: 'nav_winner', href: '/winner', group: 'discover', placement: 'main', requiresCycle: true,
		icon: '<path d="M6 9V4h12v5a6 6 0 01-12 0z"/><path d="M6 9a3 3 0 01-3-3V5h3M18 9a3 3 0 003-3V5h-3M8 19h8M12 15v4"/>' },
	{ id: 'docs', labelKey: 'nav_docs', href: '/docs', group: 'discover', placement: 'none',
		icon: '<path d="M4 4h12a4 4 0 014 4v12H8a4 4 0 01-4-4V4z"/><path d="M4 16a4 4 0 014-4h12"/>' },

	// ---- Operate (gated PER ITEM against the backend guard on each screen's primary read) ----
	// Platform (super_admin): GET /api/ops/dashboard is requireSuperAdmin (routes/ops.ts:11)
	// and getDashboard() aggregates across ALL tenants — there is no tenant-scoped variant.
	{ id: 'it-dash', labelKey: 'nav_it_dash', href: '/it-dash', group: 'operate', placement: 'settings', requiresRole: 'super_admin',
		icon: '<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>' },
	// Platform (super_admin): every /api/sandboxes route is requireSuperAdmin (routes/sandboxes.ts:93+),
	// list included — sandboxes are the platform's runtime fleet, not a tenant resource.
	{ id: 'sandboxes', labelKey: 'nav_sandboxes', href: '/sandboxes', group: 'operate', placement: 'settings', requiresRole: 'super_admin',
		badge: { countKey: 'sandboxes', color: 'var(--c-amber)' },
		icon: '<rect x="2" y="6" width="20" height="12" rx="2"/><line x1="6" y1="10" x2="6" y2="14"/><line x1="10" y1="10" x2="10" y2="14"/>' },
	// OPEN (any authenticated user): GET /api/blocks + GET /api/blocks/:slug are bare
	// `validateAuth` (routes/blocks.ts:207,297). The catalog is read-only browsing of the
	// blocks the flow builder offers; RLS already narrows it to global ∪ own tenant.
	{ id: 'blocks', labelKey: 'nav_blocks', href: '/blocks', group: 'operate', placement: 'library',
		icon: '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>' },
	// OPEN (any member of the tenant): GET /api/datasets resolves via `resolveTenant`
	// (routes/datasets.ts:168) — "test data is shared within an org, any member browses all
	// of it". Only create/edit/delete need a data manager, and the response carries
	// `canManage` which the page already uses to disable those controls. Gating the NAV on
	// the write guard is exactly the bug that hid this screen from paying tenants.
	{ id: 'datasets', labelKey: 'nav_datasets', href: '/datasets', group: 'operate', placement: 'library',
		icon: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/>' },
	// DEVELOPER-OFFERED (round 2, 2026-10-15, owner decision): the read is still open —
	// GET /api/connectors is `resolveTenant` (routes/connectors.ts:307) and the backend is NOT
	// tightened — but a member's Library offers only Building blocks + Sample data. Connectors are
	// the plumbing behind sample data (hosts, buckets, secrets); nothing a member does needs them.
	// The route stays reachable by URL and renders read-only. Allowlisted as a deliberate
	// mismatch in navConfig.backend-contract.test.ts.
	{ id: 'connectors', labelKey: 'nav_connectors', href: '/connectors', group: 'operate', placement: 'library', requiresRole: 'developer',
		icon: '<path d="M8 7H5a2 2 0 00-2 2v6a2 2 0 002 2h3"/><path d="M16 7h3a2 2 0 012 2v6a2 2 0 01-2 2h-3"/><line x1="8" y1="12" x2="16" y2="12"/>' },
	// DEVELOPER-OFFERED (round 2, same decision): GET /api/ontology + /api/ontology/matrix stay
	// `resolveTenant` (routes/ontology.ts:52,59) — the builder still reads the ontology for every
	// member — but the screen itself is the data model (entities, attributes, relations), which
	// is a developer's tool. Reachable by URL, read-only for a member; allowlisted in the contract.
	{ id: 'ontology', labelKey: 'nav_ontology', href: '/ontology', group: 'operate', placement: 'library', requiresRole: 'developer',
		icon: '<circle cx="5" cy="6" r="2.4"/><circle cx="19" cy="6" r="2.4"/><circle cx="12" cy="18" r="2.4"/><path d="M6.8 7.4l4 8.6M17.2 7.4l-4 8.6M7.4 6h9.2"/>' },
	// Developer (composite: developer OR tenant_admin OR super_admin — admin-guards.ts:39).
	// The one operate screen whose gate is NOT its read guard, and deliberately so: with no
	// ?slug it IS the create-new-block form (POST /api/blocks → requireBlockAuthor), and with
	// a slug every control on it writes (save/publish/lint/test → requireDeveloper). A member
	// reaching it gets a form whose only button 403s, so the nav shouldn't offer it. Browsing
	// an existing block read-only is what /blocks is for.
	{ id: 'block-edit', labelKey: 'nav_block_edit', href: '/block-edit', group: 'operate', placement: 'none', requiresRole: 'developer',
		icon: '<path d="M16 3l5 5-13 13H3v-5L16 3z"/>' },
	// Platform (super_admin): GET /api/pipeline is requireSuperAdmin (routes/pipeline.ts:74)
	// and `pipeline_items` is platform-global (no tenant_id) — cross-tenant by construction.
	{ id: 'pipeline', labelKey: 'nav_pipeline', href: '/pipeline', group: 'operate', placement: 'settings', requiresRole: 'super_admin',
		icon: '<path d="M3 6h18M3 12h18M3 18h18"/><circle cx="7" cy="6" r="1.5" fill="currentColor"/><circle cx="13" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="18" r="1.5" fill="currentColor"/>' },
	// Platform (super_admin): GET /api/governance is requireSuperAdmin (routes/governance.ts:71);
	// `policies` are the platform-wide guardrails (egress allowlist, model catalog), not per-tenant.
	{ id: 'governance', labelKey: 'nav_governance', href: '/governance', group: 'operate', placement: 'settings', requiresRole: 'super_admin',
		icon: '<path d="M12 2L4 6v6c0 5 3.5 9 8 10 4.5-1 8-5 8-10V6l-8-4z"/>' },
	// Platform (super_admin): GET /api/audit is requireSuperAdmin (routes/audit.ts:60) and the
	// log spans every tenant — exposing it tenant-side would be a cross-tenant disclosure.
	{ id: 'audit', labelKey: 'nav_audit', href: '/audit', group: 'operate', placement: 'settings', requiresRole: 'super_admin',
		icon: '<path d="M4 4h12l4 4v12H4V4z"/><path d="M8 11h8M8 15h5"/>' },
	// Platform (super_admin): GET /api/admin/translations/jobs is requireSuperAdmin
	// (routes/translations.ts:73) — the i18n catalog is platform content. The page already
	// renders admin_denied on the 403, but the nav should not lead anyone there.
	{ id: 'translations', labelKey: 'nav_translations', href: '/translations', group: 'operate', placement: 'settings', requiresRole: 'super_admin',
		icon: '<path d="M4 5h7M9 3v2c0 4-2.5 7-6 8"/><path d="M5 9c0 2.5 2.5 4.5 6 5"/><path d="M13 19l4-9 4 9M14.5 16h5"/>' },

	// W8/P5: members' requests for missing information / example records — reviewed by a tenant_admin
	// OR a developer (owner decision W8.3), so the gate is `developer` (composite: admins pass too).
	// In `operate`, not `administer`: that GROUP is tenant_admin-gated and would hide it from developers.
	// Placed behind the gear (/settings → Organisation), which is where the owner asked for it.
	// GET /api/information-requests is `isDeveloper`. The badge is the pending count (/api/me).
	{ id: 'requests', labelKey: 'nav_requests', href: '/requests', group: 'operate', placement: 'settings', requiresRole: 'developer',
		badge: { countKey: 'requests', color: 'var(--c-amber)' },
		icon: '<path d="M4 4h16v12H8l-4 4V4z"/><path d="M8 9h8M8 12h5"/>' },

	// ---- Administer (tenant_admin; super_admin-only items gated per-item) ----
	{ id: 'tenants', labelKey: 'nav_tenants', href: '/tenants', group: 'administer', placement: 'settings', requiresRole: 'super_admin',
		icon: '<path d="M3 21V8l6-4 6 4v13"/><path d="M15 21V11l6 4v6"/><path d="M7 12h0M7 16h0M11 12h0M11 16h0"/>' },
	// A2: the licence-plan catalogue (super_admin) — GET/POST/PATCH/DELETE /api/platform/plans.
	{ id: 'plans', labelKey: 'nav_plans', href: '/plans', group: 'administer', placement: 'settings', requiresRole: 'super_admin',
		icon: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>' },
	// Phase 4 / C.2a: controlled onboarding (super_admin) — signup queue + invite + email-domain routing.
	{ id: 'onboarding', labelKey: 'nav_onboarding', href: '/onboarding', group: 'administer', placement: 'settings', requiresRole: 'super_admin',
		icon: '<path d="M16 11a4 4 0 10-8 0M4 21a8 8 0 0116 0"/><line x1="19" y1="3" x2="19" y2="9"/><line x1="22" y1="6" x2="16" y2="6"/>' },
	{ id: 'members', labelKey: 'nav_members', href: '/members', group: 'administer', placement: 'settings', requiresRole: 'tenant_admin',
		icon: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0111 0"/><path d="M16 5.2a3.2 3.2 0 010 6M16.5 20a5.5 5.5 0 00-2-4.3"/>' },
	{ id: 'llm-settings', labelKey: 'nav_byo_keys', href: '/llm-settings', group: 'administer', placement: 'settings', requiresRole: 'tenant_admin',
		icon: '<path d="M14 7a5 5 0 10-4.9 6L10 14l2 2 2-2 2 2 2-2-2-2 .9-.9A5 5 0 0014 7z"/><circle cx="9" cy="8" r="1" fill="currentColor"/>' },
	{ id: 'mcp-keys', labelKey: 'nav_mcp_keys', href: '/mcp-keys', group: 'administer', placement: 'settings', requiresRole: 'tenant_admin',
		icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M7 13h6"/>' },
	{ id: 'usage', labelKey: 'nav_usage', href: '/usage', group: 'administer', placement: 'settings', requiresRole: 'tenant_admin',
		icon: '<path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 4-6"/>' },
	// Phase 5 / 5A: per-tenant delivery connectors (Jira / Azure DevOps / fr) — tenant_admin.
	{ id: 'delivery', labelKey: 'nav_delivery', href: '/delivery', group: 'administer', placement: 'settings', requiresRole: 'tenant_admin',
		icon: '<path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/>' },
	// Phase 4 / E.1: per-tenant Entra OIDC SSO. Tenant screen = tenant_admin; the platform
	// cross-tenant overview unlocks for super_admin only.
	{ id: 'sso', labelKey: 'nav_sso', href: '/sso', group: 'administer', placement: 'settings', requiresRole: 'tenant_admin',
		icon: '<rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V8a5 5 0 0110 0v3"/>' },
	// W7: the workspace's own voting schedule (off / weekly / monthly / quarterly / yearly, or the
	// platform default) — GET/PATCH /api/tenant/cycle-cadence are requireTenantAdmin.
	{ id: 'voting-schedule', labelKey: 'nav_voting_schedule', href: '/voting-schedule', group: 'administer', placement: 'settings', requiresRole: 'tenant_admin',
		icon: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M9 15l2 2 4-4"/>' },
	{ id: 'sso-overview', labelKey: 'nav_sso_overview', href: '/sso-overview', group: 'administer', placement: 'settings', requiresRole: 'super_admin',
		icon: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/>' }
];

// ---- visibility resolution (pure; the role gate every nav surface applies) ----
// This lives here rather than inline in Sidebar.svelte so the gate matrix is unit-
// testable: a $derived inside a .svelte component can't be exercised from a node-env
// vitest run, which is precisely why the super_admin-only-`operate` lockout shipped
// unnoticed. navConfig.test.ts drives these two functions with raw realm-role arrays.

/**
 * Does a realm-role set satisfy a gate? COMPOSITE in the same direction as the
 * backend's `middleware/admin-guards.ts` and the `auth.svelte.ts` getters this
 * mirrors: super_admin ⊇ tenant_admin ⊇ developer. `undefined` = any authenticated
 * user (the mirror of a route guarded only by `validateAuth` / `resolveTenant`).
 */
export function roleAllows(gate: RoleGate | undefined, roles: readonly string[]): boolean {
	if (!gate) return true;
	const superAdmin = roles.includes('super_admin');
	if (gate === 'super_admin') return superAdmin;
	const tenantAdmin = superAdmin || roles.includes('tenant_admin');
	if (gate === 'tenant_admin') return tenantAdmin;
	return tenantAdmin || roles.includes('developer'); // 'developer'
}

/**
 * Can this role set actually REACH the screen at `href`? For linking from OUTSIDE the
 * sidebar — a stat card, a breadcrumb, an empty-state call to action.
 *
 * ⛔ THE DEFECT. Home's "Live in production" StatCard hard-coded `href="/pipeline"`, and
 * `StatCard.svelte:23` renders an `<a>` for any href it is given. But `GET /api/pipeline` is
 * `requireSuperAdmin`, so every member and tenant_admin was offered a link, on their own
 * dashboard, to a 403 wall — while the sidebar (which consults `roleAllows`) correctly hid
 * the same screen from the same person. One product, two answers.
 *
 * ⚠️ Deliberately NOT `auth.isSuperAdmin` at the call site. That would spell `'super_admin'`
 * in a second place, and the next time a screen's guard changes, one of the two would move.
 * Looking the item up by href and delegating to `roleAllows` makes the card and the sidebar
 * literally the same gate — the nav item's `requiresRole` is the single fact both read.
 *
 * An href that is not a nav item is ungated (`roleAllows(undefined, …)` → true): the nav table
 * makes no claim about routes it does not list.
 */
export function canReachNav(href: string, roles: readonly string[]): boolean {
	const item = NAV_ITEMS.find((i) => i.href === href);
	return roleAllows(item?.requiresRole, roles);
}

/**
 * The groups (with their items) a role set may see, in render order. A group whose
 * items all fail their gate is DROPPED — otherwise a plain member would get a bare
 * "Operate" heading with nothing under it.
 */
export function visibleNav(
	roles: readonly string[],
): Array<NavGroupDef & { items: NavItem[] }> {
	return NAV_GROUPS.filter((g) => roleAllows(g.requiresRole, roles))
		.map((g) => ({
			...g,
			items: NAV_ITEMS.filter((i) => i.group === g.group && roleAllows(i.requiresRole, roles)),
		}))
		.filter((g) => g.items.length > 0);
}

// ---- sidebar composition (W2 nav declutter) ------------------------------------
// `visibleNav` answers "which screens may this role reach". The SIDEBAR answers a narrower
// question — "which of those does the chrome offer, and where" — and must stay short: before W2 a
// super_admin scrolled past 28 links and a member saw 11, which is the clutter this exists to end.

/** Context the sidebar composes against. `cycleOn` is the W5 hook: Sidebar.svelte passes
 *  `cycleOnFor(auth.user?.cycleCadence)` (cycle-nav.ts); omitted = on. */
export interface SidebarContext {
	cycleOn?: boolean;
}

/** A rendered sidebar section. `main` has no heading; `library` is collapsible, closed by default. */
export interface SidebarSection {
	section: 'main' | 'library';
	/** Paraglide key for the heading, or null for the unlabelled top section. */
	labelKey: string | null;
	collapsible: boolean;
	items: NavItem[];
}

export interface SidebarNav {
	sections: SidebarSection[];
	/** Every settings screen this role may open — the gear shows only when this is non-empty. */
	settings: NavItem[];
}

/** Is this item shown at all in the given context? The ONE predicate the cycle hook lives in. */
export function navItemShown(item: NavItem, ctx: SidebarContext = {}): boolean {
	if (item.requiresCycle && ctx.cycleOn === false) return false;
	return true;
}

/** The sidebar for a role set: two sections (empty ones dropped) + the settings list behind the gear. */
export function sidebarNav(roles: readonly string[], ctx: SidebarContext = {}): SidebarNav {
	const reachable = visibleNav(roles)
		.flatMap((g) => g.items)
		.filter((i) => navItemShown(i, ctx));
	const sections: SidebarSection[] = [
		{ section: 'main', labelKey: null, collapsible: false, items: reachable.filter((i) => i.placement === 'main') },
		{ section: 'library', labelKey: 'nav_group_library', collapsible: true, items: reachable.filter((i) => i.placement === 'library') }
	];
	return {
		sections: sections.filter((s) => s.items.length > 0),
		settings: reachable.filter((i) => i.placement === 'settings')
	};
}

/** How many entries the sidebar renders: every section item plus the gear (when shown). */
export function sidebarItemCount(nav: SidebarNav): number {
	return nav.sections.reduce((n, s) => n + s.items.length, 0) + (nav.settings.length > 0 ? 1 : 0);
}

/** How many TOP-LEVEL entries the sidebar renders while the Library is collapsed: the main
 *  items, the Library toggle, and the gear. */
export function sidebarTopLevelCount(nav: SidebarNav): number {
	return nav.sections.reduce((n, s) => n + (s.collapsible ? 1 : s.items.length), 0) + (nav.settings.length > 0 ? 1 : 0);
}

/** The sidebar's active-link rule, shared by the Sidebar, the Library toggle and the gear. */
export function isNavActive(href: string, pathname: string): boolean {
	return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(href + '/');
}

/** Settings screens split by audience for the /settings index and sub-nav: the tenant's own
 *  administration (tenant_admin) and the platform's (super_admin). */
export function settingsGroups(
	roles: readonly string[]
): Array<{ key: 'organisation' | 'platform'; labelKey: string; items: NavItem[] }> {
	const items = sidebarNav(roles).settings;
	return [
		{ key: 'organisation' as const, labelKey: 'settings_group_organisation', items: items.filter((i) => i.requiresRole !== 'super_admin') },
		{ key: 'platform' as const, labelKey: 'settings_group_platform', items: items.filter((i) => i.requiresRole === 'super_admin') }
	].filter((g) => g.items.length > 0);
}
