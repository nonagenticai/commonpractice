import { describe, it, expect } from 'vitest';
import {
	NAV_ITEMS,
	NAV_GROUPS,
	canReachNav,
	roleAllows,
	visibleNav,
	sidebarNav,
	sidebarItemCount,
	sidebarTopLevelCount,
	settingsGroups,
	navItemShown
} from './navConfig';

/** The four realm-role sets that actually reach the sidebar. */
const MEMBER = ['member'];
const DEVELOPER = ['member', 'developer'];
const TENANT_ADMIN = ['member', 'tenant_admin'];
const SUPER_ADMIN = ['member', 'super_admin'];

/** Ids a role set can see, flattened across groups. */
const visibleIds = (roles: readonly string[]): string[] =>
	visibleNav(roles).flatMap((g) => g.items.map((i) => i.id));

describe('navConfig', () => {
	it('has 7 discover + 12 operate + 11 administer nav items', () => {
		expect(NAV_ITEMS.filter((i) => i.group === 'discover')).toHaveLength(7);
		// 12 operate items: +ontology (Phase 3.2), +requests (W8/P5).
		expect(NAV_ITEMS.filter((i) => i.group === 'operate')).toHaveLength(12);
		// 11 administer items: +onboarding (C.2a), +sso & +sso-overview (E.1), +delivery (5A), +plans (A2),
		// +voting-schedule (W7).
		expect(NAV_ITEMS.filter((i) => i.group === 'administer')).toHaveLength(11);
	});

	it('includes the ontology operate screen', () => {
		const onto = NAV_ITEMS.find((i) => i.id === 'ontology');
		expect(onto).toBeDefined();
		expect(onto?.href).toBe('/ontology');
		expect(onto?.group).toBe('operate');
	});

	it('has unique hrefs and ids', () => {
		const hrefs = NAV_ITEMS.map((i) => i.href);
		const ids = NAV_ITEMS.map((i) => i.id);
		expect(new Set(hrefs).size).toBe(hrefs.length);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('every nav item belongs to a defined group', () => {
		const known = new Set(NAV_GROUPS.map((g) => g.group));
		expect(NAV_ITEMS.every((i) => known.has(i.group))).toBe(true);
	});

	it('gates groups by role: discover=any, operate=per-item (no group gate), administer=tenant_admin', () => {
		const byGroup = Object.fromEntries(NAV_GROUPS.map((g) => [g.group, g.requiresRole]));
		expect(byGroup.discover).toBeUndefined();
		// P0 REGRESSION GUARD: `operate` must NEVER carry a group-level gate again. A blanket
		// `super_admin` here locked every customer tenant_admin out of Datasets and Ontology
		// even though the backend serves both to any member of the tenant.
		expect(byGroup.operate).toBeUndefined();
		expect(byGroup.administer).toBe('tenant_admin');
	});

	it('maps each group to a message key', () => {
		for (const g of NAV_GROUPS) {
			expect(g.labelKey).toMatch(/^nav_group_/);
		}
	});

	it('gives every nav item a message key', () => {
		for (const item of NAV_ITEMS) {
			expect(item.labelKey).toMatch(/^nav_/);
		}
	});

	it('gates administer items by role: tenants+plans+onboarding+sso-overview=super_admin, rest=tenant_admin', () => {
		const admin = NAV_ITEMS.filter((i) => i.group === 'administer');
		for (const id of ['tenants', 'plans', 'onboarding', 'sso-overview']) {
			expect(admin.find((i) => i.id === id)?.requiresRole).toBe('super_admin');
		}
		for (const id of ['members', 'llm-settings', 'mcp-keys', 'usage', 'sso', 'delivery', 'voting-schedule']) {
			expect(admin.find((i) => i.id === id)?.requiresRole).toBe('tenant_admin');
		}
		// Visibility is gated on the role, never on tenant.
		expect(admin.every((i) => i.requiresRole === 'super_admin' || i.requiresRole === 'tenant_admin')).toBe(true);
	});

	// Each operate item's gate must mirror the backend guard on the route the screen needs
	// to RENDER (its primary read), not its most privileged action. Derived from:
	//   it-dash      GET /api/ops/dashboard            requireSuperAdmin  (routes/ops.ts:11)
	//   sandboxes    GET /api/sandboxes                requireSuperAdmin  (routes/sandboxes.ts:93)
	//   blocks       GET /api/blocks                   validateAuth       (routes/blocks.ts:207)
	//   datasets     GET /api/datasets                 resolveTenant      (routes/datasets.ts:168)
	//   connectors   GET /api/connectors               resolveTenant      (routes/connectors.ts:307)
	//   ontology     GET /api/ontology                 resolveTenant      (routes/ontology.ts:59)
	//   block-edit   POST /api/blocks (create-new form) requireBlockAuthor/isDeveloper
	//   pipeline     GET /api/pipeline                 requireSuperAdmin  (routes/pipeline.ts:74)
	//   governance   GET /api/governance               requireSuperAdmin  (routes/governance.ts:71)
	//   audit        GET /api/audit                    requireSuperAdmin  (routes/audit.ts:60)
	//   translations GET /api/admin/translations/jobs  requireSuperAdmin  (routes/translations.ts:73)
	it('gates operate items per-item, mirroring each screen’s backend read guard', () => {
		const gate = (id: string) => NAV_ITEMS.find((i) => i.id === id)?.requiresRole;
		for (const id of ['it-dash', 'sandboxes', 'pipeline', 'governance', 'audit', 'translations']) {
			expect(gate(id)).toBe('super_admin');
		}
		expect(gate('block-edit')).toBe('developer');
		// W8/P5: the request queue is for reviewers — tenant_admin OR developer (owner decision W8.3).
		expect(gate('requests')).toBe('developer');
		// Open to any member: the backend read guard is validateAuth / resolveTenant, and each
		// screen disables its own write controls from the server's `canManage` flag.
		for (const id of ['blocks', 'datasets']) {
			expect(gate(id)).toBeUndefined();
		}
		// Round 2 (owner decision): a member's Library is Building blocks + Sample data. Connectors
		// and Ontology are OFFERED to developers and up; their reads stay open (allowlisted in
		// navConfig.backend-contract.test.ts), so a member with the URL still gets a read-only page.
		for (const id of ['connectors', 'ontology']) {
			expect(gate(id)).toBe('developer');
		}
	});
});

// The regression this fix exists for. Driven through the SAME pure resolver the Sidebar
// renders from (`visibleNav`), so nav and test cannot drift apart.
describe('nav visibility by realm role', () => {
	it('roleAllows is composite in the backend direction (super_admin ⊇ tenant_admin ⊇ developer)', () => {
		expect(roleAllows(undefined, MEMBER)).toBe(true);
		expect(roleAllows('developer', MEMBER)).toBe(false);
		expect(roleAllows('developer', DEVELOPER)).toBe(true);
		expect(roleAllows('developer', TENANT_ADMIN)).toBe(true);
		expect(roleAllows('developer', SUPER_ADMIN)).toBe(true);
		expect(roleAllows('tenant_admin', DEVELOPER)).toBe(false);
		expect(roleAllows('tenant_admin', TENANT_ADMIN)).toBe(true);
		expect(roleAllows('tenant_admin', SUPER_ADMIN)).toBe(true);
		expect(roleAllows('super_admin', TENANT_ADMIN)).toBe(false);
		expect(roleAllows('super_admin', SUPER_ADMIN)).toBe(true);
	});

	// THE P0: a real customer's tenant_admin could not reach Datasets or Ontology — the two
	// screens that make the flow builder do anything with their own data — because the whole
	// `operate` group was super_admin-gated. Invisible in testing: the test identity is
	// super_admin, which passes every gate.
	it('a tenant_admin sees Datasets and Ontology (the P0 lockout)', () => {
		const ids = visibleIds(TENANT_ADMIN);
		expect(ids).toContain('datasets');
		expect(ids).toContain('ontology');
	});

	it('a tenant_admin sees every operate screen the backend serves them', () => {
		const ids = visibleIds(TENANT_ADMIN);
		// resolveTenant / validateAuth reads + developer authoring (tenant_admin is composite).
		for (const id of ['blocks', 'datasets', 'connectors', 'ontology', 'block-edit']) {
			expect(ids).toContain(id);
		}
		// ...and none of the platform-only ones, which would 403 on requireSuperAdmin.
		for (const id of ['it-dash', 'sandboxes', 'pipeline', 'governance', 'audit', 'translations']) {
			expect(ids).not.toContain(id);
		}
	});

	it('a developer sees the authoring screens but no platform or tenant-admin screens', () => {
		const ids = visibleIds(DEVELOPER);
		for (const id of ['blocks', 'datasets', 'connectors', 'ontology', 'block-edit']) {
			expect(ids).toContain(id);
		}
		for (const id of ['it-dash', 'sandboxes', 'pipeline', 'governance', 'audit', 'translations']) {
			expect(ids).not.toContain(id);
		}
		// `administer` is tenant_admin-gated at the group level — a developer is not an admin.
		expect(visibleNav(DEVELOPER).some((g) => g.group === 'administer')).toBe(false);
	});

	it('a plain member sees no platform-only item and nothing the backend would refuse', () => {
		const ids = visibleIds(MEMBER);
		// Platform-only (requireSuperAdmin on the primary read).
		for (const id of ['it-dash', 'sandboxes', 'pipeline', 'governance', 'audit', 'translations']) {
			expect(ids).not.toContain(id);
		}
		// Authoring-only (requireBlockAuthor/requireDeveloper on every control it offers).
		expect(ids).not.toContain('block-edit');
		// Whole admin group.
		expect(visibleNav(MEMBER).some((g) => g.group === 'administer')).toBe(false);
		// But the member Library screens ARE offered: Building blocks and Sample data.
		for (const id of ['blocks', 'datasets']) {
			expect(ids).toContain(id);
		}
		// …and the data plumbing and the data model are not (round 2, owner decision).
		for (const id of ['connectors', 'ontology']) {
			expect(ids).not.toContain(id);
		}
		// Discover is untouched: every item stays open to any authenticated user.
		expect(NAV_ITEMS.filter((i) => i.group === 'discover').every((i) => ids.includes(i.id))).toBe(true);
	});

	it('a super_admin still sees every nav item (no privilege was lost in the split)', () => {
		expect(visibleIds(SUPER_ADMIN).sort()).toEqual(NAV_ITEMS.map((i) => i.id).sort());
	});

	it('never renders a group heading with no items under it', () => {
		for (const roles of [[], MEMBER, DEVELOPER, TENANT_ADMIN, SUPER_ADMIN]) {
			for (const g of visibleNav(roles)) {
				expect(g.items.length).toBeGreaterThan(0);
			}
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// canReachNav — linking to a screen from OUTSIDE the sidebar.
//
// ⛔ THE DEFECT. Home's "Live in production" StatCard hard-coded `href="/pipeline"`, and
// `StatCard.svelte:23` renders an `<a>` for any href it is given. `GET /api/pipeline` is
// `requireSuperAdmin`, so every member and tenant_admin was offered a link — on their own
// dashboard — to a 403 wall, while the sidebar correctly hid the same screen from the same
// person. One product, two answers about who may go where.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('canReachNav', () => {
	it('THE DEFECT — /pipeline is unreachable for everyone the backend would refuse', () => {
		expect(canReachNav('/pipeline', MEMBER)).toBe(false);
		expect(canReachNav('/pipeline', DEVELOPER)).toBe(false);
		expect(canReachNav('/pipeline', TENANT_ADMIN)).toBe(false);
		expect(canReachNav('/pipeline', SUPER_ADMIN)).toBe(true);
	});

	it('an ungated Discover screen stays reachable for a plain member', () => {
		// The fix must not over-correct into hiding links that work: /challenges is
		// `validateAuth` only, so every authenticated user may follow it.
		expect(canReachNav('/challenges', MEMBER)).toBe(true);
		expect(canReachNav('/solutions', MEMBER)).toBe(true);
	});

	it('is the SAME gate the sidebar uses, for every nav item and every role set', () => {
		// This is the whole point of deriving it from `requiresRole` instead of spelling
		// `'super_admin'` a second time at the call site: card and sidebar cannot disagree.
		for (const roles of [[], MEMBER, DEVELOPER, TENANT_ADMIN, SUPER_ADMIN]) {
			const inSidebar = new Set(visibleIds(roles));
			for (const item of NAV_ITEMS) {
				// `administer` also carries a GROUP gate, which canReachNav deliberately does not
				// model (it answers "may this role use the screen", not "is it in the chrome").
				if (item.group === 'administer' && !roleAllows('tenant_admin', roles)) continue;
				expect(canReachNav(item.href, roles), `${item.href} for [${roles}]`).toBe(
					inSidebar.has(item.id)
				);
			}
		}
	});

	it('makes no claim about an href that is not a nav item', () => {
		expect(canReachNav('/not-a-screen', MEMBER)).toBe(true);
	});

	it('the /pipeline nav item still carries the gate this all derives from', () => {
		// Removing `requiresRole` from the item would silently make canReachNav return true for
		// everyone AND put /pipeline back in every member's sidebar. Pinned here so the two
		// symptoms cannot be fixed apart.
		expect(NAV_ITEMS.find((i) => i.href === '/pipeline')?.requiresRole).toBe('super_admin');
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// W2 nav declutter (2026-10-14). Before: a member saw 11 sidebar links and a super_admin 28.
// The sidebar now offers a short main section, a collapsed Library, and a gear for every admin
// screen. `visibleNav` (above) still answers "may this role reach it"; these pin "is it OFFERED".
// ─────────────────────────────────────────────────────────────────────────────────────────────
const ids = (items: { id: string }[]) => items.map((i) => i.id);

describe('sidebarNav — the decluttered sidebar', () => {
	it('a member sees exactly Home, Challenges, Solutions, Build, Results + the Library', () => {
		const nav = sidebarNav(MEMBER);
		expect(nav.sections.map((s) => s.section)).toEqual(['main', 'library']);
		expect(ids(nav.sections[0]!.items)).toEqual(['home', 'challenges', 'solutions', 'build', 'winner']);
		expect(ids(nav.sections[1]!.items)).toEqual(['blocks', 'datasets']);
		expect(nav.settings, 'a member has no settings screen, so no gear').toEqual([]);
	});

	it('⛔ member sidebar has at most 6 top-level entries (5 links + the collapsed Library)', () => {
		expect(sidebarTopLevelCount(sidebarNav(MEMBER))).toBeLessThanOrEqual(6);
	});

	it('⛔ no role ever gets more than 10 sidebar entries, super_admin included', () => {
		for (const roles of [MEMBER, DEVELOPER, TENANT_ADMIN, SUPER_ADMIN]) {
			expect(sidebarItemCount(sidebarNav(roles)), `[${roles}]`).toBeLessThanOrEqual(10);
		}
		// Non-vacuity: the super_admin sidebar is not empty, it is SHORT.
		expect(sidebarItemCount(sidebarNav(SUPER_ADMIN))).toBeGreaterThanOrEqual(9);
	});

	it('Submit and Getting started are not in the sidebar (button on Home/Challenges; topbar "?")', () => {
		for (const roles of [MEMBER, SUPER_ADMIN]) {
			const shown = sidebarNav(roles).sections.flatMap((s) => ids(s.items));
			expect(shown).not.toContain('submit');
			expect(shown).not.toContain('docs');
		}
		// …but still reachable: placement never changes the role gate.
		expect(canReachNav('/submit', MEMBER)).toBe(true);
		expect(canReachNav('/docs', MEMBER)).toBe(true);
	});

	it('every tenant_admin / super_admin item lives behind the gear, never in the sidebar', () => {
		for (const roles of [TENANT_ADMIN, SUPER_ADMIN]) {
			const nav = sidebarNav(roles);
			const inSidebar = nav.sections.flatMap((s) => s.items);
			expect(inSidebar.filter((i) => i.requiresRole === 'tenant_admin' || i.requiresRole === 'super_admin')).toEqual([]);
		}
		const adminItems = NAV_ITEMS.filter((i) => i.requiresRole === 'tenant_admin' || i.requiresRole === 'super_admin');
		// …plus the one developer-gated screen that also lives behind the gear (W8/P5 requests).
		expect(ids(sidebarNav(SUPER_ADMIN).settings).sort()).toEqual([...ids(adminItems), 'requests'].sort());
	});

	it('settings keep the role gates: a tenant_admin gets only Organisation, a super_admin both', () => {
		const ta = settingsGroups(TENANT_ADMIN);
		expect(ta.map((g) => g.key)).toEqual(['organisation']);
		expect(ids(ta[0]!.items)).toEqual(['requests', 'members', 'llm-settings', 'mcp-keys', 'usage', 'delivery', 'sso', 'voting-schedule']);
		const sa = settingsGroups(SUPER_ADMIN);
		expect(sa.map((g) => g.key)).toEqual(['organisation', 'platform']);
		expect(sa[1]!.items.every((i) => i.requiresRole === 'super_admin')).toBe(true);
		expect(settingsGroups(MEMBER)).toEqual([]);
		// W8/P5: a developer reviews requests, so the gear shows them Organisation → Requests only.
		const dev = settingsGroups(DEVELOPER);
		expect(dev.map((g) => g.key)).toEqual(['organisation']);
		expect(ids(dev[0]!.items)).toEqual(['requests']);
	});

	it('every item has an explicit placement', () => {
		for (const i of NAV_ITEMS) expect(['main', 'library', 'settings', 'none']).toContain(i.placement);
	});

	it('⚑ cycle hook: Results is the only cycle-bound item and drops out when the cycle is off', () => {
		expect(NAV_ITEMS.filter((i) => i.requiresCycle).map((i) => i.id)).toEqual(['winner']);
		const winner = NAV_ITEMS.find((i) => i.id === 'winner')!;
		expect(navItemShown(winner)).toBe(true);
		expect(navItemShown(winner, { cycleOn: false })).toBe(false);
		const off = sidebarNav(MEMBER, { cycleOn: false }).sections[0]!;
		expect(ids(off.items)).toEqual(['home', 'challenges', 'solutions', 'build']);
	});
});
