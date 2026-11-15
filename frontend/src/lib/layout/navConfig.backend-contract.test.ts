// src/lib/layout/navConfig.backend-contract.test.ts — the sidebar's role gates AGREE WITH THE
// BACKEND GUARD ON THE SCREEN'S PRIMARY READ, in both directions.
//
// ⛔ THE DEFECT THIS PINS IS THE ONE NO OTHER TEST IN THIS REPO CAN SEE. Every automated identity
// and every browser proof this product has ever had ran as a `super_admin`
// (`backend/src/middleware/auth.ts` — `DEFAULT_BYPASS_ROLES = ['super_admin']`), and a super_admin
// passes EVERY gate on both sides. So the frontend's declaration in `navConfig.ts` and the
// backend's enforcement in `middleware/admin-guards.ts` (+ the per-file `require*` wrappers) have
// never once been compared against each other by anything that runs. `navConfig.test.ts` asserts
// the DECLARATION only — item counts, unique ids/hrefs, `visibleNav`'s output — which is a test of
// the table against itself.
//
// Two directions, both of which have already shipped to a paying customer:
//   • GATE TOO WEAK  — a member/developer is offered a nav item whose primary read refuses them.
//     Best case a localized refusal, worst case a dead screen.
//   • GATE TOO STRONG — a role the API would serve happily never sees the item. This is the P0 the
//     header of `navConfig.ts` records: `operate` carried a blanket `requiresRole: 'super_admin'`
//     and a real tenant_admin could not reach Datasets or Ontology.
//
// backend/ and frontend/ are two separate Bun projects — no workspaces, no shared package, no
// codegen — so, exactly as `../i18n/graph-issue-label.backend-contract.test.ts` and its siblings do,
// this walks BACKEND SOURCE TEXT on disk with plain `fs`. It ALSO walks the frontend's own api
// clients, so the endpoint each screen reads is DERIVED, not asserted from a hand-written constant
// that would rot the first time a page changed its loader.
//
// The chain, per nav item, all four links checked:
//   navConfig `requiresRole`  ←→  the page really calls this api method (page source)
//                             ←→  that method really hits this endpoint (api client source)
//                             ←→  that endpoint's handler really calls this guard (backend source)
//                             ←→  that guard's role (backend source, incl. per-file wrappers)
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { NAV_ITEMS, NAV_GROUPS, type RoleGate } from './navConfig';

const BACKEND = fileURLToPath(new URL('../../../../backend', import.meta.url));
const BACKEND_ROUTES = join(BACKEND, 'src', 'routes');
const FRONTEND_SRC = fileURLToPath(new URL('../..', import.meta.url));

// ---------------------------------------------------------------- the gate lattice

/** undefined = any authenticated user. Composite in the backend's own direction. */
type Gate = RoleGate | undefined;
const RANK: Record<string, number> = { developer: 1, tenant_admin: 2, super_admin: 3 };
const rank = (g: Gate): number => (g ? RANK[g]! : 0);
const strongest = (a: Gate, b: Gate): Gate => (rank(a) >= rank(b) ? a : b);
const show = (g: Gate): string => g ?? '(any authenticated)';

/**
 * The role a backend guard demands.
 *
 * ⛔ `resolveTenant` AND `validateAuth` BOTH MAP TO "ANY AUTHENTICATED USER", and that is the whole
 * point of this file. `resolveTenant` (middleware/tenant.ts) resolves the caller's tenant from the
 * `tenant_id` claim and derives a role, but it REFUSES NOBODY who holds a claim — it is the shape
 * "any member of the org may read this". Reading it as an admin gate because its name contains
 * "tenant" is exactly the mistake that produced the tenant_admin lockout.
 *
 * `peekEffectiveTenant` is deliberately absent: it is documented as never-throwing and cannot deny.
 */
const GLOBAL_GUARDS: Record<string, Gate> = {
	requireSuperAdmin: 'super_admin',
	requireTenantAdmin: 'tenant_admin',
	requireAnyAdmin: 'tenant_admin',
	requireDeveloper: 'developer',
	requireBlockAuthor: 'developer',
	resolveTenant: undefined,
	validateAuth: undefined,
	authenticateWithoutLicense: undefined
};
/** Never denies — see `middleware/tenant.ts`'s own comment. Excluded from the strongest-of. */
const NON_DENYING = new Set(['peekEffectiveTenant']);

// ---------------------------------------------------------------- backend readers

/**
 * Blank out comments — and, with `alsoStrings`, string/template-literal CONTENTS — preserving
 * every newline and every byte offset so the `^`-anchored and `\n`-delimited scans below behave
 * exactly as they do on the raw source.
 *
 * ⛔ THE RATCHET BELOW WAS DEFEATED BY A COMMENT, MEASURED. Downgrading `GET /api/audit` from
 * `await requireSuperAdmin(req)` to `await resolveTenant(req)` — genuinely opening the platform
 * audit feed to every authenticated user — and leaving behind the note
 * `// restore requireSuperAdmin(req) before release` made this file report 9 passed, GREEN. Remove
 * the comment and the identical downgrade goes red. The guard scan matched the guard's NAME in
 * prose, so a line of English was accepted as enforcement. (`~/.claude` memory: "A guard can be
 * defeated by a comment".) String literals go the same way — `forbidden('requireSuperAdmin(req)')`
 * is a message, not a call — so the guard scan blanks those too. `router.add('GET', '/api/…')`
 * still needs its literals, which is why stripping strings is opt-in rather than global.
 */
export function blankOut(src: string, alsoStrings: boolean): string {
	const hollow = (s: string) => s.replace(/[^\n]/g, ' ');
	let out = '';
	let i = 0;
	while (i < src.length) {
		const c = src[i]!;
		const n = src[i + 1];
		if (c === '/' && n === '/') {
			const j = src.indexOf('\n', i);
			const end = j === -1 ? src.length : j;
			out += hollow(src.slice(i, end));
			i = end;
			continue;
		}
		if (c === '/' && n === '*') {
			const j = src.indexOf('*/', i + 2);
			const end = j === -1 ? src.length : j + 2;
			out += hollow(src.slice(i, end));
			i = end;
			continue;
		}
		if (c === "'" || c === '"' || c === '`') {
			const end = endOfLiteral(src, i);
			out += alsoStrings ? hollow(src.slice(i, end)) : src.slice(i, end);
			i = end;
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

/** Index just past the literal opening at `start`, honouring escapes and `${…}` interpolation. */
function endOfLiteral(src: string, start: number): number {
	const q = src[start]!;
	let i = start + 1;
	while (i < src.length) {
		const c = src[i]!;
		if (c === '\\') {
			i += 2;
			continue;
		}
		if (q === '`' && c === '$' && src[i + 1] === '{') {
			let depth = 1;
			i += 2;
			while (i < src.length && depth > 0) {
				const d = src[i]!;
				if (d === "'" || d === '"' || d === '`') {
					i = endOfLiteral(src, i);
					continue;
				}
				if (d === '{') depth++;
				else if (d === '}') depth--;
				i++;
			}
			continue;
		}
		if (c === q) return i + 1;
		// An unterminated ' or " is a regex character class (`/['"]/`), not a string. Stop at the
		// line end rather than swallowing the rest of the file.
		if (q !== '`' && c === '\n') return i;
		i++;
	}
	return src.length;
}

/** Comments removed; string literals intact, because the route table is built from them. */
export const stripComments = (src: string): string => blankOut(src, false);

const routeFiles = readdirSync(BACKEND_ROUTES).filter(
	(f) => f.endsWith('.ts') && !f.includes('.test.')
);
const backendSrc = new Map(
	routeFiles.map(
		(f) => [f, stripComments(readFileSync(join(BACKEND_ROUTES, f), 'utf8'))] as const
	)
);

/** A guard-ish call this file makes: the shared ones plus any local `require*` wrapper. */
const GUARD_CALL_RE = /\b(require[A-Za-z]\w*|resolveTenant|validateAuth|authenticateWithoutLicense|peekEffectiveTenant)\s*\(/g;

/** Block keywords whose body may be skipped at runtime. `try` counts: a `catch` can swallow. */
const CONDITIONAL_HEAD = /\b(?:if|else|for|while|switch|case|catch|do|try)\b/;
/** `x && await requireX(` / `x ? await requireX(` — the same "may not run" shape without braces. */
const SHORTCIRCUIT_HEAD = /(?:&&|\|\||\?\?|\?)[\s(]*(?:await[\s(]+)?$/;

/**
 * Every guard-ish call in a handler body, each flagged with whether it sits on a CONDITIONAL path.
 *
 * ⛔ A GUARD THAT MAY NOT RUN IS NOT A GUARD. `if (process.env.ALLOW) await requireSuperAdmin(req)`
 * reads to a name-matching scan exactly like an unconditional call, so the strongest-of below
 * would report `super_admin` for an endpoint that is open whenever the branch is not taken. Such a
 * call is therefore DROPPED — folded to the weakest possible gate — and the endpoint's gate comes
 * from the calls that always run.
 */
export function guardCallsIn(body: string): { name: string; conditional: boolean }[] {
	const code = blankOut(body, true);
	const hits = [...code.matchAll(new RegExp(GUARD_CALL_RE.source, 'g'))].map((m) => ({
		at: m.index!,
		name: m[1]!
	}));
	const out: { name: string; conditional: boolean }[] = [];
	const stack: boolean[] = []; // one entry per open `{`: does that block hang off a branch?
	let seg = 0; // start of the current statement, i.e. just past the last `;` `{` `}`
	let mi = 0;
	const branchy = (head: string) => CONDITIONAL_HEAD.test(head) || SHORTCIRCUIT_HEAD.test(head);
	for (let i = 0; i < code.length && mi < hits.length; i++) {
		while (mi < hits.length && hits[mi]!.at === i) {
			out.push({
				name: hits[mi]!.name,
				conditional: stack.some(Boolean) || branchy(code.slice(seg, i))
			});
			mi++;
		}
		const c = code[i]!;
		if (c === '{') {
			stack.push(stack.some(Boolean) || branchy(code.slice(seg, i)));
			seg = i + 1;
		} else if (c === '}') {
			stack.pop();
			seg = i + 1;
		} else if (c === ';') {
			seg = i + 1;
		}
	}
	return out;
}

/**
 * The gate a handler BODY really enforces: the strongest of the guards that ALWAYS run.
 * Split out of `guardsForEndpoint` so the comment- and conditional-path evasions can be driven
 * over fixtures below instead of waiting for a real route to wear one.
 */
export function gateOfHandlerBody(
	src: string,
	body: string,
	where: string
): { gate: Gate; guards: string[] } {
	const calls = guardCallsIn(body).filter((c) => !NON_DENYING.has(c.name));
	if (calls.length === 0) throw new Error(`handler '${where}' calls NO guard at all`);
	const always = calls.filter((c) => !c.conditional);
	if (always.length === 0) {
		throw new Error(
			`handler '${where}' calls ${[...new Set(calls.map((c) => c.name))].join('+')} only on a ` +
				`CONDITIONAL path — a guard that may not run is not a guard`
		);
	}
	const names = [...new Set(always.map((c) => c.name))];
	let gate: Gate = undefined;
	for (const n of names) {
		gate = strongest(gate, n in GLOBAL_GUARDS ? GLOBAL_GUARDS[n] : localGuardGate(src, n));
	}
	return { gate, guards: names };
}

/**
 * The body of a top-level `const NAME = …` / `function NAME(…)` in a backend route file: from the
 * declaration to the next declaration that starts at column 0.
 *
 * ⛔ IT DOES NOT PARSE TYPESCRIPT, and it does not need to — but it MUST fail loudly when it finds
 * nothing, or every guard lookup below returns "no guards" and this whole file passes on an empty
 * set. Callers throw on a miss; `guardsForEndpoint` turns a miss into a named failure.
 */
export function declBody(src: string, name: string): string | null {
	const at = src.search(new RegExp(`^(?:const|async function|function)\\s+${name}\\b`, 'm'));
	if (at === -1) return null;
	const rest = src.slice(at + 1);
	const nx = rest.search(/\n(?:const|function|async function|export)\s/);
	return rest.slice(0, nx === -1 ? rest.length : nx);
}

/**
 * The role a PER-FILE `require*` wrapper demands, derived from its own body.
 *
 * ⛔ THE SAME NAME MEANS TWO DIFFERENT ROLES IN THIS CODEBASE, MEASURED. `requireDataManager` in
 * `routes/datasets.ts` gates on `isDeveloper` (a developer may add test data), while the
 * identically-named `requireDataManager` in `routes/connectors.ts` gates on
 * `ctx.role === 'tenant_admin'` (a live external source with stored credentials is an IT decision),
 * and both files say so in a comment. A single global name→role table would silently give one of
 * the two screens the wrong answer forever, so wrappers are resolved IN THE FILE THEY LIVE IN.
 */
export function localGuardGate(src: string, name: string): Gate {
	const raw = declBody(stripComments(src), name);
	if (raw === null) throw new Error(`guard '${name}' is not defined in this route file`);
	// ⛔ CALLS ARE MATCHED ON CODE ONLY. Comments are already gone; string literals go too, so a
	// message like `forbidden('super_admin_required', 'call requireSuperAdmin first')` cannot make
	// a wrapper look stronger than it is. The role LITERAL test below needs `'tenant_admin'` to
	// survive, so it keeps the string-bearing body.
	const body = blankOut(raw, true);
	// A wrapper that delegates to a shared guard inherits its role.
	for (const [g, gate] of Object.entries(GLOBAL_GUARDS)) {
		if (rank(gate) > 0 && new RegExp(`\\b${g}\\s*\\(`).test(body)) return gate;
	}
	// A wrapper of the `resolveTenant` + `canManageX(ctx)` shape: the predicate carries the role.
	const pred = body.match(/\b(canManage\w+)\s*\(/);
	if (pred) {
		const predBody = declBody(stripComments(src), pred[1]!);
		if (predBody === null) throw new Error(`predicate '${pred[1]}' not found`);
		if (/\bisDeveloper\s*\(/.test(predBody)) return 'developer';
		if (/'tenant_admin'|\bhasTenantAdmin\s*\(/.test(predBody)) return 'tenant_admin';
		if (/\bisSuperAdmin\s*\(/.test(predBody)) return 'super_admin';
		throw new Error(`predicate '${pred[1]}' has an unrecognised role test`);
	}
	if (/\b(resolveTenant|validateAuth|authenticateWithoutLicense)\s*\(/.test(body)) return undefined;
	throw new Error(`guard '${name}' has an unrecognised shape`);
}

interface BackendRoute {
	file: string;
	method: string;
	/** Path with every `:param` segment normalised to `*`. */
	path: string;
	handler: string;
}

/** Every `router.add('GET', '/api/…', handler)` in backend/src/routes. */
function backendRoutes(): BackendRoute[] {
	const out: BackendRoute[] = [];
	for (const [file, src] of backendSrc) {
		for (const m of src.matchAll(
			/router\.add\(\s*'([A-Z]+)'\s*,\s*'([^']+)'\s*,\s*([A-Za-z_$][\w$]*)/g
		)) {
			out.push({ file, method: m[1]!, path: normalisePath(m[2]!), handler: m[3]! });
		}
	}
	return out;
}

/** `:id` / `${…}` segments collapse to `*` so the two sides can be compared at all. */
function normalisePath(p: string): string {
	return p
		.split('?')[0]!
		.split('/')
		.map((s) => (s.startsWith(':') ? '*' : s))
		.join('/');
}

const ROUTES = backendRoutes();

/** The role the backend actually demands of `METHOD path` — the STRONGEST guard on the handler. */
function guardsForEndpoint(method: string, path: string): { gate: Gate; guards: string[]; where: string } {
	const hits = ROUTES.filter((r) => r.method === method && r.path === path);
	if (hits.length !== 1) {
		throw new Error(
			`${method} ${path} matched ${hits.length} backend routes (expected exactly 1)`
		);
	}
	const r = hits[0]!;
	const src = backendSrc.get(r.file)!;
	const body = declBody(src, r.handler);
	if (body === null) throw new Error(`handler '${r.handler}' not found in ${r.file}`);
	const where = `${r.file}:${r.handler}`;
	return { ...gateOfHandlerBody(src, body, where), where };
}

// ---------------------------------------------------------------- frontend readers

/** The body of one `async name(` method inside an exported `…Api = {` object literal. */
function apiMethodBody(module: string, method: string): string {
	const file = join(FRONTEND_SRC, 'lib', 'api', `${module}.ts`);
	if (!existsSync(file)) throw new Error(`api module not found: ${file}`);
	const src = readFileSync(file, 'utf8');
	const at = src.search(new RegExp(`^\\t(?:async\\s+)?${method}\\s*[(<]`, 'm'));
	if (at === -1) throw new Error(`api method '${module}.${method}' not found`);
	const rest = src.slice(at + 1);
	const nx = rest.search(/\n\t(?:async\s+)?[A-Za-z_$][\w$]*\s*[(<]/);
	return rest.slice(0, nx === -1 ? rest.length : nx);
}

/**
 * The endpoint one api method calls, normalised the same way the backend table is.
 *
 * `${…}` interpolations become a sentinel first, THEN the query string is cut — a placeholder can
 * legitimately contain a `?` (`` `/api/admin/translations/jobs${qs ? `?${qs}` : ''}` ``), and
 * cutting first would truncate the path at a character that is not a query separator.
 */
export function endpointOf(body: string): string {
	const m = body.match(/\/api\/(?:[^`'"$\s)]|\$\{[^}]*\})*/);
	if (!m) throw new Error('no /api/ endpoint literal in this api method body');
	const SENT = ' ';
	const withSentinels = m[0].replace(/\$\{[^}]*\}/g, SENT);
	return withSentinels
		.split('?')[0]!
		.split('/')
		.map((s) => (s === SENT ? '*' : s.split(SENT).join('')))
		.join('/');
}

// ---------------------------------------------------------------- the declared table
//
// One row per nav item. `pageCall` is the expression the PAGE really invokes (asserted against the
// page's own source); `api` is the client method that carries the endpoint literal. They differ
// only where the page calls a paging wrapper — that delegation is asserted too, so the wrapper
// cannot quietly start reading somewhere else.

interface PrimaryRead {
	/** Route file, relative to src/routes, whose `onMount` performs the read. */
	page: string;
	/** Substring that MUST appear in the page source. `null` = the screen makes no API call. */
	pageCall: string | null;
	/** `<api module>#<method>` that owns the endpoint literal. */
	api: string | null;
	/** Set when the page calls a wrapper that delegates to `api`. */
	via?: string;
}

const PRIMARY_READ: Record<string, PrimaryRead> = {
	home: { page: '+page.svelte', pageCall: 'marketplaceApi.home(', api: 'marketplace#home' },
	challenges: { page: 'challenges/+page.svelte', pageCall: 'challengesApi.list(', api: 'challenges#list' },
	// `listAll` pages the whole set through `datasetsApi.list` — the endpoint (and therefore the
	// guard) is the same one; the delegation is asserted below.
	submit: { page: 'submit/+page.svelte', pageCall: 'datasetsApi.listAll(', api: 'datasets#list', via: 'datasets#listAll' },
	solutions: { page: 'solutions/+page.svelte', pageCall: 'solutionsApi.list(', api: 'solutions#list' },
	build: { page: 'build/+page.svelte', pageCall: 'blocksApi.list(', api: 'blocks#list' },
	winner: { page: 'winner/+page.svelte', pageCall: 'marketplaceApi.winner(', api: 'marketplace#winner' },
	// ⚠️ THE ONE SCREEN WITH NO PRIMARY READ. /docs is static prose; it calls no api client at all,
	// so there is no guard to agree with. Asserted as a NEGATIVE below (the page must contain no
	// `$lib/api` import) so this row cannot be used to smuggle a real screen out of the contract.
	docs: { page: 'docs/+page.svelte', pageCall: null, api: null },
	'it-dash': { page: 'it-dash/+page.svelte', pageCall: 'opsApi.dashboard(', api: 'ops#dashboard' },
	sandboxes: { page: 'sandboxes/+page.svelte', pageCall: 'sandboxesApi.list(', api: 'sandboxes#list' },
	blocks: { page: 'blocks/+page.svelte', pageCall: 'blocksApi.list(', api: 'blocks#list' },
	datasets: { page: 'datasets/+page.svelte', pageCall: 'datasetsApi.list(', api: 'datasets#list' },
	connectors: { page: 'connectors/+page.svelte', pageCall: 'connectorsApi.list(', api: 'connectors#list' },
	// `load()` starts at the matrix; the cell graph (`ontologyApi.get`) is behind the same guard.
	ontology: { page: 'ontology/+page.svelte', pageCall: 'ontologyApi.matrix(', api: 'ontology#matrix' },
	'block-edit': { page: 'block-edit/+page.svelte', pageCall: 'blocksApi.get(', api: 'blocks#get' },
	pipeline: { page: 'pipeline/+page.svelte', pageCall: 'pipelineApi.board(', api: 'pipeline#board' },
	governance: { page: 'governance/+page.svelte', pageCall: 'governanceApi.get(', api: 'governance#get' },
	audit: { page: 'audit/+page.svelte', pageCall: 'auditApi.list(', api: 'audit#list' },
	translations: { page: 'translations/+page.svelte', pageCall: 'translationsApi.jobs(', api: 'translations#jobs' },
	// W8/P5: the queue — GET /api/information-requests, `requireReviewer` → `canManageRequests` → isDeveloper.
	requests: { page: 'requests/+page.svelte', pageCall: 'informationRequestsApi.list(', api: 'information-requests#list' },
	tenants: { page: '(platform)/tenants/+page.svelte', pageCall: 'adminApi.allTenants(', api: 'admin#allTenants' },
	plans: { page: '(platform)/plans/+page.svelte', pageCall: 'adminApi.plans(', api: 'admin#plans' },
	onboarding: { page: '(platform)/onboarding/+page.svelte', pageCall: 'adminApi.signupApprovals(', api: 'admin#signupApprovals' },
	members: { page: '(tenant)/members/+page.svelte', pageCall: 'adminApi.members(', api: 'admin#members' },
	'llm-settings': { page: '(tenant)/llm-settings/+page.svelte', pageCall: 'llmSettingsApi.catalog(', api: 'llm-settings#catalog' },
	'mcp-keys': { page: '(tenant)/mcp-keys/+page.svelte', pageCall: 'mcpKeysApi.list(', api: 'mcpKeys#list' },
	usage: { page: '(tenant)/usage/+page.svelte', pageCall: 'adminApi.usage(', api: 'admin#usage' },
	delivery: { page: '(tenant)/delivery/+page.svelte', pageCall: 'deliveryApi.list(', api: 'delivery#list' },
	sso: { page: '(tenant)/sso/+page.svelte', pageCall: 'adminApi.ssoProviders(', api: 'admin#ssoProviders' },
	'sso-overview': { page: '(platform)/sso-overview/+page.svelte', pageCall: 'adminApi.allSsoProviders(', api: 'admin#allSsoProviders' },
	// W7: GET /api/tenant/cycle-cadence (routes/tenant-cycle-cadence.ts) is requireTenantAdmin.
	'voting-schedule': { page: '(tenant)/voting-schedule/+page.svelte', pageCall: 'cycleApi.tenantCadence(', api: 'cycle#tenantCadence' }
};

/**
 * ⛔ THE DELIBERATE-MISMATCH ALLOWLIST. Every entry is a gate that does NOT equal its primary
 * read's guard, ON PURPOSE, with the reason on one line. An entry that is not here fails the
 * contract. Adding one is a decision, not a formality: it is the exact shape the P0 wore.
 */
const ALLOWED_MISMATCH: Record<string, { declared: Gate; backend: Gate; reason: string }> = {
	// The read is open (`GET /api/blocks/:slug` is bare `validateAuth`), but with no `?slug` this
	// route IS the create-new-block form and EVERY control on it writes (POST /api/blocks →
	// requireBlockAuthor; save/publish/lint/test → requireDeveloper). A member reaching it gets a
	// form whose only button 403s, so the nav must not offer it. Read-only browsing is /blocks.
	'block-edit': { declared: 'developer', backend: undefined, reason: 'every control writes; the open read is only the detail fetch — browsing lives at /blocks' },
	// Round 2 (2026-10-15, owner decision): a member's Library is Building blocks + Sample data.
	// The reads stay open on purpose — the builder needs the ontology for every member, and the
	// backend is not tightened — so these are nav-OFFER gates over open reads, the same shape as
	// block-edit. The routes stay reachable by URL and render read-only for a member.
	connectors: { declared: 'developer', backend: undefined, reason: 'members are not offered the data plumbing (hosts, buckets, secrets); the open read stays for read-only URL access' },
	ontology: { declared: 'developer', backend: undefined, reason: 'the data-model screen is a developer tool; the open read stays because the builder reads the ontology for every member' }
};

// ---------------------------------------------------------------- the measurement

interface Row {
	id: string;
	declared: Gate;
	group: string;
	endpoint: string | null;
	backend: Gate;
	guards: string[];
	where: string;
}

const groupGate = new Map(NAV_GROUPS.map((g) => [g.group, g.requiresRole] as const));

const MAPPED: Row[] = [];
const UNMAPPED: string[] = [];
for (const item of NAV_ITEMS) {
	const pr = PRIMARY_READ[item.id];
	if (!pr) continue; // caught by the coverage assertion below
	// EFFECTIVE gate = the strongest of the group's and the item's. A member never reaches an
	// `administer` item however open its own gate is.
	const declared = strongest(groupGate.get(item.group), item.requiresRole);
	if (!pr.api) {
		UNMAPPED.push(item.id);
		continue;
	}
	const [mod, method] = pr.api.split('#') as [string, string];
	const endpoint = endpointOf(apiMethodBody(mod, method));
	const { gate, guards, where } = guardsForEndpoint('GET', endpoint);
	MAPPED.push({ id: item.id, declared, group: item.group, endpoint, backend: gate, guards, where });
}

// ---------------------------------------------------------------- the contract

describe('nav gates ↔ backend guards (non-vacuity first)', () => {
	it('⛔ found real tables on BOTH sides — nothing below passes on an empty set', () => {
		// THE ANCHOR, FIRST ON PURPOSE. Break a path, a regex, or the router's registration shape and
		// every comparison after this would compare nothing to nothing and report green.
		// W8/P5: +1 `requests` (the information-request queue) (with W7 voting-schedule) → 30.
		expect(NAV_ITEMS).toHaveLength(30);
		expect(ROUTES.length).toBeGreaterThanOrEqual(120);
		expect(ROUTES.filter((r) => r.method === 'GET').length).toBeGreaterThanOrEqual(40);
		expect(MAPPED.length).toBeGreaterThanOrEqual(20);
		// …and the mapped set really spans the lattice, so an extractor that collapsed every guard
		// to one value cannot hide behind a table that agrees with itself.
		//
		// ⚠️ A FLOOR, NOT AN EXACT SET. This used to be
		// `toEqual(['(any authenticated)', 'super_admin', 'tenant_admin'])`, which pins the exact
		// census of gates the mapped screens happen to use today — so a legitimate, correct move
		// (a screen's guard tightened from open to tenant_admin, or the first nav screen whose
		// primary read is `requireDeveloper`) reds this anchor for no defect. `developer` is in
		// RANK and reachable through `localGuardGate`, but no LIVE backend gate on a mapped
		// screen's primary read resolves to it, so the exact list can only ever shrink or grow by
		// accident. What the anchor actually needs is that the extractor did not collapse
		// everything to one value: three distinct gates spanning both ends of the lattice.
		const gates = new Set(MAPPED.map((r) => show(r.backend)));
		expect(gates.size, `every mapped screen resolved to ${[...gates]}`).toBeGreaterThanOrEqual(3);
		expect(
			[...gates],
			'no screen resolved to "any authenticated" — the open end is unexercised'
		).toContain('(any authenticated)');
		expect(
			[...gates],
			'no screen resolved to super_admin — the closed end is unexercised'
		).toContain('super_admin');
		expect(new Set(MAPPED.flatMap((r) => r.guards)).size).toBeGreaterThanOrEqual(4);
	});

	it('every nav item has a declared primary read (or an explicit "none")', () => {
		const ids = NAV_ITEMS.map((i) => i.id);
		expect(ids.filter((id) => !(id in PRIMARY_READ))).toEqual([]);
		expect(Object.keys(PRIMARY_READ).filter((id) => !ids.includes(id))).toEqual([]);
		// Exactly one screen may claim "no API call", and it must really make none.
		expect(UNMAPPED).toEqual(['docs']);
	});

	it('every declared page file exists and really makes the call this table claims', () => {
		let asserted = 0;
		for (const [id, pr] of Object.entries(PRIMARY_READ)) {
			const file = join(FRONTEND_SRC, 'routes', pr.page);
			expect(existsSync(file), `${id}: missing route file ${pr.page}`).toBe(true);
			const src = readFileSync(file, 'utf8');
			if (pr.pageCall === null) {
				// The negative half of the "no primary read" claim.
				expect(src, `${id}: claims no API call but imports an api client`).not.toContain('$lib/api/');
				continue;
			}
			expect(src, `${id}: page does not call ${pr.pageCall}`).toContain(pr.pageCall);
			if (pr.via) {
				// The wrapper really delegates to the method whose endpoint we measured.
				const [mod, method] = pr.api!.split('#') as [string, string];
				const [, wrapper] = pr.via.split('#') as [string, string];
				expect(apiMethodBody(mod, wrapper), `${id}: ${pr.via} does not delegate to ${pr.api}`)
					.toMatch(new RegExp(`\\b${method}\\s*\\(`));
			}
			asserted++;
		}
		expect(asserted).toBe(NAV_ITEMS.length - 1);
	});

	it('⛔ every nav gate EQUALS the backend guard on its screen — both directions', () => {
		// THIS IS THE GUARD. `toEqual` on the whole diff, not a loop of individual expects, so a
		// failure names every offender at once instead of stopping at the first.
		const offenders = MAPPED.filter((r) => {
			const allow = ALLOWED_MISMATCH[r.id];
			if (allow && allow.declared === r.declared && allow.backend === r.backend) return false;
			return r.declared !== r.backend;
		}).map((r) => {
			const dir = rank(r.declared) > rank(r.backend) ? 'TOO STRONG (locks out)' : 'TOO WEAK (403 wall)';
			return `${r.id}: nav=${show(r.declared)} backend=${show(r.backend)} [${dir}] — GET ${r.endpoint} → ${r.guards.join('+')} (${r.where})`;
		});
		expect(offenders).toEqual([]);
	});

	it('the allowlist is exact — no stale entry, and each one still describes a real mismatch', () => {
		// An allowlist that outlives its mismatch is a hole: the item's gate could be changed to
		// anything and this file would keep excusing it. Each entry must still be a live mismatch
		// AND still carry the exact pair of values it was granted for.
		for (const [id, allow] of Object.entries(ALLOWED_MISMATCH)) {
			const row = MAPPED.find((r) => r.id === id);
			expect(row, `allowlist names '${id}', which is not a mapped nav item`).toBeDefined();
			expect(row!.declared, `${id}: allowlist declared-gate is stale`).toBe(allow.declared);
			expect(row!.backend, `${id}: allowlist backend-gate is stale`).toBe(allow.backend);
			expect(row!.declared, `${id}: allowlisted but no longer a mismatch — delete the entry`).not.toBe(row!.backend);
			expect(allow.reason.length, `${id}: allowlist entry needs a reason`).toBeGreaterThan(20);
		}
		// Keep it small on purpose. Every entry is a screen where the nav and the API disagree.
		expect(Object.keys(ALLOWED_MISMATCH).length).toBeLessThanOrEqual(3);
	});

	it('no nav gate is stronger than its group needs to be (the P0 shape, from the other end)', () => {
		// The blanket-group-gate defect stated positively: an item whose own gate is WEAKER than its
		// group's is fine (the group wins), but a GROUP whose gate exceeds every one of its items'
		// backend guards is the lockout. Measured per group.
		for (const g of NAV_GROUPS) {
			const rows = MAPPED.filter((r) => r.group === g.group);
			if (rows.length === 0) continue;
			const weakestBackend = rows.reduce<Gate>((acc, r, i) => (i === 0 ? r.backend : rank(r.backend) < rank(acc) ? r.backend : acc), undefined);
			expect(
				rank(g.requiresRole),
				`group '${g.group}' gate ${show(g.requiresRole)} exceeds its most open screen (${show(weakestBackend)})`
			).toBeLessThanOrEqual(rank(weakestBackend));
		}
	});
});

describe('⛔ the extractors themselves, driven over fixtures', () => {
	// Every assertion above is only as good as these three regex-level readers, and a reader that
	// silently returns the wrong thing makes the whole file report green about nothing. Same
	// standard as the sibling contract tests: drive the parser, do not wait for the bug.

	it('endpointOf normalises params, template suffixes and query strings', () => {
		expect(endpointOf("return unwrap(await authFetch('/api/ops/dashboard'));")).toBe('/api/ops/dashboard');
		expect(endpointOf('return unwrap(await authFetch(`/api/admin/tenants${suffix}`));')).toBe('/api/admin/tenants');
		expect(endpointOf('await authFetch(`/api/blocks/${encodeURIComponent(slug)}`)')).toBe('/api/blocks/*');
		expect(endpointOf('await authFetch(`/api/tenants/${tenantId}/members`, x)')).toBe('/api/tenants/*/members');
		// The `?` inside the placeholder must NOT truncate the path (translations does exactly this).
		expect(endpointOf('await authFetch(`/api/admin/translations/jobs${qs ? `?${qs}` : ``}`)')).toBe(
			'/api/admin/translations/jobs'
		);
		// …and a real query string must be cut.
		expect(endpointOf('await authFetch(`/api/tenants/${id}/usage?range=${rangeDays}`)')).toBe(
			'/api/tenants/*/usage'
		);
		expect(() => endpointOf('return unwrap(await somethingElse());')).toThrow(/no \/api\//);
	});

	it('localGuardGate resolves a per-file wrapper from ITS OWN file, not a global name table', () => {
		// The measured hazard, as a fixture: one name, two roles, two files.
		const DATASETS = [
			"function canManageData(ctx: TenantContext): boolean {",
			'  return isDeveloper(ctx.user);',
			'}',
			'',
			'async function requireDataManager(req: Request): Promise<TenantContext> {',
			'  const ctx = await resolveTenant(req);',
			'  if (!canManageData(ctx)) {',
			"    throw forbidden('data_manager_required', 'nope');",
			'  }',
			'  return ctx;',
			'}',
			''
		].join('\n');
		const CONNECTORS = DATASETS.replace(
			'return isDeveloper(ctx.user);',
			"return ctx.role === 'tenant_admin' || isSuperAdmin(ctx.user);"
		);
		expect(localGuardGate(DATASETS, 'requireDataManager')).toBe('developer');
		expect(localGuardGate(CONNECTORS, 'requireDataManager')).toBe('tenant_admin');
		// A wrapper that delegates to a shared guard inherits it…
		const DELEGATING = [
			'async function requireOps(req: Request) {',
			'  return await requireSuperAdmin(req);',
			'}',
			''
		].join('\n');
		expect(localGuardGate(DELEGATING, 'requireOps')).toBe('super_admin');
		// …and an unrecognised shape THROWS rather than defaulting to "open", which would silently
		// turn a real admin gate into "any authenticated user" and pass the contract.
		expect(() => localGuardGate('function requireX(req) {\n  return magic(req);\n}\n', 'requireX')).toThrow();
		expect(() => localGuardGate('const other = 1;\n', 'requireX')).toThrow(/not defined/);
	});

	it('⛔ a guard that appears ONLY IN A COMMENT is not a guard', () => {
		// THE MEASURED EVASION, as a fixture. Downgrading the real `GET /api/audit` handler from
		// `requireSuperAdmin` to `resolveTenant` and leaving the note
		// `// restore requireSuperAdmin(req) before release` behind made this whole file report
		// 9 passed / GREEN while the platform audit feed was open to every authenticated user.
		// Delete the comment and the identical downgrade goes red. A line of English was being read
		// as enforcement.
		const DOWNGRADED = [
			'const getAudit = route(async (req) => {',
			'  const ctx = await resolveTenant(req);',
			'  return jsonResponse(ctx);',
			'});',
			''
		].join('\n');
		const WITH_ALIBI = DOWNGRADED.replace(
			'const ctx = await resolveTenant(req);',
			'  // TODO: restore requireSuperAdmin(req) before release\n  const ctx = await resolveTenant(req);'
		);
		// Same handler, same enforcement, therefore the SAME answer — the comment must not move it.
		expect(gateOfHandlerBody('', DOWNGRADED, 'audit.ts:getAudit')).toEqual({
			gate: undefined,
			guards: ['resolveTenant']
		});
		expect(gateOfHandlerBody('', WITH_ALIBI, 'audit.ts:getAudit')).toEqual({
			gate: undefined,
			guards: ['resolveTenant']
		});
		// …and a handler whose ONLY mention of any guard is a comment has no guard at all, which is
		// a loud failure rather than a silent "open".
		const COMMENT_ONLY = [
			'const getAudit = route(async (req) => {',
			'  /* guarded by requireSuperAdmin(req) upstream */',
			'  return jsonResponse([]);',
			'});',
			''
		].join('\n');
		expect(() => gateOfHandlerBody('', COMMENT_ONLY, 'audit.ts:getAudit')).toThrow(
			/calls NO guard at all/
		);
		// A guard NAMED IN A STRING is prose too — an error message, not enforcement.
		const STRING_ONLY = [
			'const getAudit = route(async (req) => {',
			"  throw forbidden('super_admin_required', 'call requireSuperAdmin(req) first');",
			'});',
			''
		].join('\n');
		expect(() => gateOfHandlerBody('', STRING_ONLY, 'audit.ts:getAudit')).toThrow(
			/calls NO guard at all/
		);
		// And `blankOut` must not damage what the route table is built from.
		const ROUTE_LINE = "router.add('GET', '/api/audit', getAudit); // platform only";
		expect(stripComments(ROUTE_LINE)).toContain("router.add('GET', '/api/audit', getAudit);");
		expect(stripComments(ROUTE_LINE)).not.toContain('platform only');
		// Offsets and lines are preserved, so every `^`/`\n`-anchored scan above is unaffected.
		const MULTI = "const a = 1; /* x\ny */ const b = '2'; // z\nconst c = 3;\n";
		expect(stripComments(MULTI)).toHaveLength(MULTI.length);
		expect(stripComments(MULTI).split('\n')).toHaveLength(MULTI.split('\n').length);
	});

	it('⛔ a guard on a CONDITIONAL path folds to the weakest — it may not run', () => {
		// `if (process.env.X) await requireSuperAdmin(req)` reads to a name-matching scan exactly
		// like an unconditional call, so the strongest-of would report `super_admin` for an endpoint
		// that is wide open whenever the branch is not taken.
		const BRANCHED = [
			'const getAudit = route(async (req) => {',
			'  const ctx = await resolveTenant(req);',
			'  if (process.env.STRICT_AUDIT) await requireSuperAdmin(req);',
			'  return jsonResponse(ctx);',
			'});',
			''
		].join('\n');
		expect(guardCallsIn(BRANCHED)).toEqual([
			{ name: 'resolveTenant', conditional: false },
			{ name: 'requireSuperAdmin', conditional: true }
		]);
		expect(gateOfHandlerBody('', BRANCHED, 'audit.ts:getAudit')).toEqual({
			gate: undefined,
			guards: ['resolveTenant']
		});
		// Braced, and short-circuited, are the same shape.
		const BRACED = BRANCHED.replace(
			'if (process.env.STRICT_AUDIT) await requireSuperAdmin(req);',
			'if (flag) {\n    await requireSuperAdmin(req);\n  }'
		);
		expect(gateOfHandlerBody('', BRACED, 'x:y').gate).toBeUndefined();
		const SHORTCIRCUIT = BRANCHED.replace(
			'if (process.env.STRICT_AUDIT) await requireSuperAdmin(req);',
			'flag && (await requireSuperAdmin(req));'
		);
		expect(gateOfHandlerBody('', SHORTCIRCUIT, 'x:y').gate).toBeUndefined();
		// A handler whose ONLY guard is conditional is not guarded — say so, loudly.
		const ONLY_CONDITIONAL = [
			'const getAudit = route(async (req) => {',
			'  if (process.env.STRICT_AUDIT) await requireSuperAdmin(req);',
			'  return jsonResponse([]);',
			'});',
			''
		].join('\n');
		expect(() => gateOfHandlerBody('', ONLY_CONDITIONAL, 'audit.ts:getAudit')).toThrow(
			/only on a CONDITIONAL path/
		);
		// ⚠️ THE OTHER DIRECTION, or the fold is just a way to weaken every gate. A guard that
		// really does always run must stay unconditional even with branches elsewhere in the body.
		const UNCONDITIONAL = [
			'const getAudit = route(async (req) => {',
			'  const user = await requireSuperAdmin(req);',
			'  if (user.x) { doThing(); }',
			'  for (const r of rows) { collect(r); }',
			'  return jsonResponse([]);',
			'});',
			''
		].join('\n');
		expect(gateOfHandlerBody('', UNCONDITIONAL, 'x:y')).toEqual({
			gate: 'super_admin',
			guards: ['requireSuperAdmin']
		});
	});

	it('the backend route scrape really sees the two shapes it must see', () => {
		// The real table, spot-checked by name in both directions: one platform route and one open
		// one. If `router.add`'s shape changes, this is what names it.
		expect(guardsForEndpoint('GET', '/api/ops/dashboard')).toMatchObject({
			gate: 'super_admin',
			where: 'ops.ts:dashboard'
		});
		expect(guardsForEndpoint('GET', '/api/datasets')).toMatchObject({ gate: undefined });
		expect(guardsForEndpoint('GET', '/api/tenants/*/members')).toMatchObject({ gate: 'tenant_admin' });
		// An endpoint nothing registers must FAIL, not resolve to "open".
		expect(() => guardsForEndpoint('GET', '/api/does-not-exist')).toThrow(/matched 0/);
	});
});
