// src/lib/i18n/ontology-axis-label.test.ts — the ontology matrix axes resolve from the vocabulary
// the BACKEND SEED actually ships, and /ontology no longer prints any of it raw.
//
// Two halves, because a label module can be perfect and unimported:
//   1. The module — every industry and department in backend/src/ontology/seed/*.json resolves to a
//      message, the enum being DERIVED FROM THE SEED rather than hand-listed, and an off-list value
//      comes back raw.
//   2. The route — a source scan for the four pre-fix expressions on routes/ontology/+page.svelte,
//      each pattern proven against the literal string it replaced. Mounting that page (SvelteFlow,
//      four API clients, a confirm store) to assert one text node would cost far more than it
//      proves; same trade, same idiom, as leaderboard-row.work-area.render.test.ts.
//
// The messages module is mocked so each key returns its own name: the assertions are about WHICH
// MESSAGE is selected, not about copy a translator may legitimately reword. The one place real copy
// IS asserted is the Dutch check at the bottom, which reads the catalog directly — a guard that only
// says "not English" passes on a blank string.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';

vi.mock('$lib/paraglide/messages', () => ({
	industry_banking: () => 'M_BANKING',
	industry_healthcare: () => 'M_HEALTHCARE',
	industry_insurance: () => 'M_INSURANCE',
	domain_finance: () => 'M_FINANCE',
	domain_hr: () => 'M_HR',
	domain_claims: () => 'M_CLAIMS',
	domain_sales: () => 'M_SALES',
	domain_service: () => 'M_SERVICE',
	domain_legal: () => 'M_LEGAL',
	domain_marketing: () => 'M_MARKETING',
	domain_risk: () => 'M_RISK',
	domain_ops: () => 'M_OPS',
	domain_it: () => 'M_IT',
	ontology_scope_generic: () => 'M_SCOPE_GENERIC',
	ontology_scope_industry: () => 'M_SCOPE_INDUSTRY',
	ontology_scope_industry_dept: () => 'M_SCOPE_INDUSTRY_DEPT'
}));

const { industryLabel, departmentLabel, ontologyScopeLabel } = await import('./ontology-axis-label');
const { workAreaLabel } = await import('./work-area-label');

const SEED_DIR = resolve(process.cwd(), '../backend/src/ontology/seed');

const SEED_LIST_FILE = '../backend/src/ontology/i18n-seed.ts';
const SEED_LIST_SYMBOL = 'ONTOLOGY_SEED_FILES';
const LOADER_FILE = '../backend/src/db/seed-ontology.ts';

/**
 * The seed files the loader actually reads, SCRAPED FROM THE BACKEND.
 *
 * ⛔ THIS LIST USED TO BE HAND-WRITTEN, AND THAT MADE THE GUARD BELOW A FRAUD. Adding a department
 * to an existing seed file reddened correctly — but adding a whole new overlay (`retail.json`)
 * shipped an untranslated `retail` chip with this file 31/31 green, because the scrape never
 * opened the file. A derived list is only as complete as its most hand-written link; this was the
 * hand-written link.
 *
 * ⛔ CORRECTED — THE CONSTANT MOVED, AND THIS GUARD IS WHY WE FOUND OUT. It read
 * `const SEED_FILES` out of backend/src/db/seed-ontology.ts. A backend change de-duplicated the
 * seed-JSON layer (one loader, shared with the ontology i18n key derivation) and the constant
 * became `export const ONTOLOGY_SEED_FILES` in backend/src/ontology/i18n-seed.ts. The regex then
 * matched nothing and all five derived cases FAILED CLOSED — exactly as intended, and the only
 * signal in the whole repo that a cross-boundary consumer existed: the backend author ran backend
 * tests, the reviewer approved a backend refactor, and the sole consumer was this frontend file.
 *
 * The lesson kept here rather than in a commit message: this scrape is a CONSUMER OF BACKEND
 * SOURCE. Moving or renaming the symbol below is a breaking change to a file in another workspace.
 */
function seedFiles(): string[] {
	const src = readFileSync(resolve(process.cwd(), SEED_LIST_FILE), 'utf8');
	const decl = new RegExp(`export const ${SEED_LIST_SYMBOL} = \\[([^\\]]+)\\]`).exec(src);
	expect(
		decl,
		`${SEED_LIST_SYMBOL} moved or was renamed in ${SEED_LIST_FILE} — this test scrapes it to ` +
			`derive the ontology matrix axes. Repoint SEED_LIST_FILE/SEED_LIST_SYMBOL above at the new ` +
			`home; do NOT hand-list the seed files here, that is the defect this guard exists to catch.`
	).not.toBeNull();
	return [...decl![1].matchAll(/'([^']+)'/g)].map((mm) => mm[1]!);
}

interface SeedFile {
	industry?: string;
	entities?: { name: string; department?: string }[];
}

function seed(file: string): SeedFile {
	return JSON.parse(readFileSync(resolve(SEED_DIR, file), 'utf8')) as SeedFile;
}

/**
 * The two axes as `listMatrix` builds them (backend/src/ontology/ontology-service.ts:469-482):
 * industries come from rows whose scope is `industry` / `industry_dept` — i.e. the overlay files'
 * top-level `industry` key — and departments from rows whose scope is `generic` / `industry_dept`,
 * i.e. any entity carrying a `department`.
 */
function seededAxes(): { industries: string[]; departments: string[] } {
	const industries = new Set<string>();
	const departments = new Set<string>();
	for (const f of seedFiles()) {
		const s = seed(f);
		if (s.industry) industries.add(s.industry);
		for (const e of s.entities ?? []) if (e.department) departments.add(e.department);
	}
	return { industries: [...industries].sort(), departments: [...departments].sort() };
}

describe('ontology axis vocabulary', () => {
	it('the scrape reads every seed file the loader loads — no more, no less', () => {
		// ⛔ NON-VACUITY, AND THE HOLE THAT LET A NEW OVERLAY THROUGH. If the scrape read nothing,
		// every "each seeded value resolves" assertion below would iterate an EMPTY set and pass
		// while the chips stayed English.
		const files = seedFiles();
		expect(files.length).toBeGreaterThanOrEqual(4);
		for (const f of files) expect(existsSync(resolve(SEED_DIR, f)), `${f} is registered in seed-ontology.ts but absent`).toBe(true);

		// …and the loader's list covers the whole seed directory, so a new overlay cannot arrive
		// without either this guard seeing it or the loader ignoring it too. Deliberately an
		// equality, not a subset: a `retail.json` sitting unregistered on disk is worth a failure
		// in one direction or the other, never silence.
		const onDisk = readdirSync(SEED_DIR).filter((f) => f.endsWith('.json')).sort();
		expect(
			[...files].sort(),
			`the seed directory and ${SEED_LIST_SYMBOL} in ${SEED_LIST_FILE} disagree`
		).toEqual(onDisk);
	});

	it('the loader actually CONSUMES the constant this test scrapes', () => {
		// ⛔ THE HOLE THE MOVE OPENED, CLOSED. Scraping a list proves nothing unless the seeder reads
		// the SAME list: a constant that is exported but unused, or a loader that kept a private copy
		// after a half-finished de-duplication, would leave this file happily deriving axes from a
		// list nothing seeds. The previous version could not make this check — it scraped the loader
		// itself, so consumption was tautological. Now that the constant lives in another module it
		// is a real invariant, so it is asserted.
		const loader = readFileSync(resolve(process.cwd(), LOADER_FILE), 'utf8');
		expect(loader, `${LOADER_FILE} no longer imports ${SEED_LIST_SYMBOL}`).toContain(SEED_LIST_SYMBOL);
		expect(
			loader,
			`${LOADER_FILE} names ${SEED_LIST_SYMBOL} but does not iterate it — it may have grown a ` +
				`private file list again, which is what this whole scrape guards against`
		).toMatch(new RegExp(`for \\(const \\w+ of ${SEED_LIST_SYMBOL}\\)`));
		// …and no second declaration crept back into the loader.
		expect(loader, `${LOADER_FILE} re-declared a private seed-file list`).not.toMatch(
			/const SEED_FILES = \[/
		);
	});

	it('the parsed axes are non-empty and shaped as expected', () => {
		// ⚠️ ANCHORS, NOT AN EXHAUSTIVE LIST. The previous version asserted
		// `industries).toEqual(['banking','healthcare','insurance'])`, which pinned the very thing
		// this file is supposed to let grow — a fourth vertical would have reddened HERE, in a
		// non-vacuity check, rather than in the resolution test that actually means something.
		const { industries, departments } = seededAxes();
		expect(industries.length).toBeGreaterThanOrEqual(3);
		expect(departments.length).toBeGreaterThanOrEqual(8);
		// ⛔ EVERY KNOWN MEMBER, ASSERTED INDIVIDUALLY — but still `toContain`, never `toEqual`.
		// A length check alone is satisfied by three wrong strings, and after the scrape silently
		// pointed at nothing this is the assertion that says the parse produced the REAL vocabulary
		// rather than merely a non-empty one. `toContain` per member keeps a fourth vertical or a
		// ninth department free to arrive without reddening a non-vacuity check — the pin this file
		// deliberately removed once already.
		for (const ind of ['banking', 'healthcare', 'insurance']) expect(industries).toContain(ind);
		for (const dep of ['Claims', 'Finance', 'HR', 'Legal', 'Marketing', 'Ops', 'Sales', 'Service'])
			expect(departments).toContain(dep);
	});

	it('every INDUSTRY the seed ships resolves to a message — derived from the seed, not hand-listed', () => {
		const { industries } = seededAxes();
		const labels = industries.map(industryLabel);
		for (const [i, label] of labels.entries()) {
			expect(
				label,
				`industry '${industries[i]}' has no catalog key — it fell through to the raw value`
			).toMatch(/^M_/);
		}
		// No two verticals collapse onto one word, which would make two chips indistinguishable.
		expect(new Set(labels).size).toBe(industries.length);
	});

	it('every DEPARTMENT the seed ships resolves to a message — derived from the seed, not hand-listed', () => {
		const { departments } = seededAxes();
		const labels = departments.map(departmentLabel);
		for (const [i, label] of labels.entries()) {
			expect(
				label,
				`department '${departments[i]}' has no catalog key — it fell through to the raw value`
			).toMatch(/^M_/);
		}
		expect(new Set(labels).size).toBe(departments.length);
	});

	it('the scope vocabulary has exactly one implementation', () => {
		// ⛔ `OntologyEntityNode.svelte` carried its own `scopeLabel` over the same three keys — and
		// the two diverged where it matters: the local one ended `return m.ontology_scope_industry_dept()`,
		// so an unrecognised scope was ASSERTED to be a specialization, while this module returns the
		// raw value. Two mechanisms for one word is the defect this whole change is about.
		const node = readFileSync(
			resolve(process.cwd(), 'src/lib/components/ontology/OntologyEntityNode.svelte'),
			'utf8'
		);
		const LOCAL = /function scopeLabel\s*\(/;
		expect(LOCAL.test('	function scopeLabel(scope: OntologyScope): string {'), 'pattern does not match its own defect').toBe(true);
		expect(LOCAL.test(node), 'OntologyEntityNode re-declared a local scopeLabel').toBe(false);
		expect(node).toContain("from '$lib/i18n/ontology-axis-label'");
		expect(node).toContain('ontologyScopeLabel(entity.scope)');
	});

	it('the department axis and the work-area enum share their six common words', () => {
		// ⛔ THE POINT OF DELEGATING TO `workAreaLabel` RATHER THAN RE-SWITCHING. The two enums are
		// different sets, but their intersection must be ONE word each: a reader who filtered
		// challenges by "Schadeclaims" has to meet "Schadeclaims" on the ontology chip. If someone
		// gives `departmentLabel` its own `case 'Claims'` pointing at a new key, this reddens.
		const src = readFileSync(resolve(process.cwd(), '../backend/src/routes/challenges.ts'), 'utf8');
		const decl = /export const WORK_AREAS = \[([^\]]+)\]/.exec(src);
		expect(decl, 'WORK_AREAS moved or was renamed in backend/src/routes/challenges.ts').not.toBeNull();
		const workAreas = [...decl![1].matchAll(/'([^']+)'/g)].map((mm) => mm[1]!);

		const shared = seededAxes().departments.filter((d) => workAreas.includes(d));
		expect(shared.length).toBeGreaterThanOrEqual(6); // Claims, Legal, Marketing, Ops, Sales, Service
		for (const d of shared) {
			// Compared against the other public entry point rather than restating the mapping a
			// third time — and both must be a real message, not two matching raw fallbacks.
			expect(departmentLabel(d), `'${d}' resolves to a different message on the two screens`).toBe(
				workAreaLabel(d)
			);
			expect(departmentLabel(d), `'${d}' fell through on BOTH screens`).toMatch(/^M_/);
		}
	});

	it('resolves every scope in the closed tri-state', () => {
		expect(ontologyScopeLabel('generic')).toBe('M_SCOPE_GENERIC');
		expect(ontologyScopeLabel('industry')).toBe('M_SCOPE_INDUSTRY');
		expect(ontologyScopeLabel('industry_dept')).toBe('M_SCOPE_INDUSTRY_DEPT');
	});

	it('the scope tri-state is the one both sides of the wire declare', () => {
		// Derived, not hand-listed — and from BOTH declarations, because they can drift apart.
		const be = readFileSync(resolve(process.cwd(), '../backend/src/routes/ontology.ts'), 'utf8');
		const beDecl = /scope: z\.enum\(\[([^\]]+)\]\)/.exec(be);
		expect(beDecl, 'the scope z.enum moved in backend/src/routes/ontology.ts').not.toBeNull();
		const beScopes = [...beDecl![1].matchAll(/'([^']+)'/g)].map((mm) => mm[1]!);

		const fe = readFileSync(resolve(process.cwd(), 'src/lib/types/ontology.ts'), 'utf8');
		const feDecl = /export type OntologyScope = ([^;]+);/.exec(fe);
		expect(feDecl, 'OntologyScope moved in src/lib/types/ontology.ts').not.toBeNull();
		const feScopes = [...feDecl![1].matchAll(/'([^']+)'/g)].map((mm) => mm[1]!);

		expect(beScopes.sort()).toEqual(feScopes.sort());
		// ⚠️ And it is `generic`, NOT `global` — a plausible-looking wrong value that would make the
		// detail subtitle fall through to the raw enum while every assertion above stayed green.
		expect(beScopes).toContain('generic');
		expect(beScopes).not.toContain('global');
		for (const s of beScopes) expect(ontologyScopeLabel(s)).toMatch(/^M_SCOPE_/);
	});

	it('returns the RAW VALUE for a value the seed does not ship — never a prettified guess', () => {
		// ⛔ NOT AN EDGE CASE — THE ORDINARY PATH FOR TENANT DATA. `createEntitySchema` types both
		// axes as `z.string().max(80).nullish()` (no z.enum), and `listMatrix` unions tenant rows
		// into the axes, so one custom entity puts an arbitrary string on these chips.
		expect(industryLabel('logistics')).toBe('logistics');
		expect(industryLabel('Insurance')).toBe('Insurance'); // case-sensitive: the slugs are lowercase
		expect(departmentLabel('Procurement')).toBe('Procurement');
		expect(departmentLabel('claims')).toBe('claims'); // case-sensitive: the axis is capitalised
		expect(ontologyScopeLabel('global')).toBe('global');
		expect(industryLabel('')).toBe('');
		expect(departmentLabel('')).toBe('');
	});

	it('every key it reaches exists in all eight catalogs, with a real non-English Dutch value', () => {
		const LOCALES = ['en', 'nl', 'pl', 'fr', 'es', 'de', 'ar', 'he'];
		const KEYS = [
			'industry_banking',
			'industry_healthcare',
			'industry_insurance',
			'domain_finance',
			'domain_hr',
			'ontology_scope_generic',
			'ontology_scope_industry',
			'ontology_scope_industry_dept'
		];
		for (const locale of LOCALES) {
			const catalog = JSON.parse(
				readFileSync(resolve(process.cwd(), `messages/${locale}.json`), 'utf8')
			) as Record<string, unknown>;
			for (const key of KEYS) {
				expect(typeof catalog[key], `${key} is missing from ${locale}.json`).toBe('string');
				expect(String(catalog[key]).trim(), `${locale}.${key} is blank`).not.toBe('');
			}
		}

		// ⛔ ASSERT THE POSITIVE. "not English" is satisfied by a blank, by a key echo, and by a
		// placeholder someone pasted to make parity green. These are the words a Dutch reader must
		// see on the two chip rows, and they are the reason this whole change exists.
		const nl = JSON.parse(readFileSync(resolve(process.cwd(), 'messages/nl.json'), 'utf8')) as Record<
			string,
			string
		>;
		expect(nl.industry_insurance).toBe('Verzekeringen');
		expect(nl.industry_banking).toBe('Bankwezen');
		expect(nl.industry_healthcare).toBe('Zorg');
		expect(nl.domain_claims).toBe('Schadeclaims');
		expect(nl.domain_finance).toBe('Financiën');
		expect(nl.ontology_scope_industry_dept).toBe('Specialisatie');
		// …so the Dutch graph header reads "Verzekeringen × Schadeclaims", not "insurance × Claims".
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ⛔ THE SCAN THAT SHOULD HAVE EXISTED FIRST.
//
// The original version of this file read exactly ONE route — routes/ontology/+page.svelte — and
// declared the axis fixed. Review found FOUR more live render sites it was structurally incapable
// of seeing, one of them (/datasets) the reported defect verbatim on a screen equally nav-open to
// every tenant member. A guard scoped to the file you happened to fix measures your memory, not
// the codebase.
//
// So: walk every .svelte under src/ and fail on any raw render of a matrix axis value. "Raw" means
// the loop variable of a `{#each …industries/…departments}` reaching a text position without a
// label function around it.
describe('no .svelte anywhere renders a matrix axis value raw', () => {
	const SRC = resolve(process.cwd(), 'src');

	function svelteFiles(dir: string): string[] {
		const out: string[] = [];
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) {
				if (name === 'paraglide' || name === 'node_modules') continue; // generated / vendored
				out.push(...svelteFiles(full));
			} else if (name.endsWith('.svelte')) out.push(full);
		}
		return out;
	}

	/**
	 * Every `{#each <expr>.industries|departments … as <var> …}` in a file, paired with the raw
	 * text renders of `<var>` that follow it. A text render is `>{var}<` (an element's whole text)
	 * or `{var}{#if` / `{var} ` at the start of a line — the shapes the five real defects had.
	 */
	function rawAxisRenders(src: string): string[] {
		const hits: string[] = [];
		// ⚠️ NO REQUIRED `.` BEFORE THE FIELD NAME. The first version of this matcher demanded
		// `<expr>.industries`, which is how `BlockAuthorAssistant.svelte` slipped past it AGAIN in
		// the very commit meant to close this hole: it copies the axes into local `industries` /
		// `departments` variables first (`industries = mx.industries`) and loops the BARE
		// identifier. The same shape is why a `grep` for `.industries` under-reports.
		const each = /\{#each\s+[^}]*?\b(industries|departments)\b[^}]*?\s+as\s+([A-Za-z_$][\w$]*)/g;
		for (const mm of src.matchAll(each)) {
			const v = mm[2]!;
			const tail = src.slice(mm.index! + mm[0].length);
			// stop at the matching {/each} so a later loop's variable is not attributed here
			const end = tail.indexOf('{/each}');
			const body = end === -1 ? tail : tail.slice(0, end);
			const esc = v.replace(/\$/g, '\\$');
			const RAW = new RegExp(`>\\s*\\{${esc}\\}|\\{${esc}\\}\\{#if|^\\s*\\{${esc}\\}`, 'm');
			if (RAW.test(body)) hits.push(`${mm[1]} as ${v}`);
		}
		return hits;
	}

	const files = svelteFiles(SRC);

	it('the walk found the real component tree', () => {
		// Non-vacuity: an empty file list, or a walk that missed the routes, passes everything.
		expect(files.length).toBeGreaterThan(40);
		expect(files.some((f) => f.endsWith('routes/ontology/+page.svelte'))).toBe(true);
		expect(files.some((f) => f.endsWith('routes/datasets/+page.svelte'))).toBe(true);
	});

	it('the matcher matches the five expressions this change actually replaced', () => {
		// ⛔ Byte-for-byte the pre-fix lines, from all five files. A scanner that matches nothing
		// passes forever — this is the assertion that stops that.
		const PRE_FIX = [
			// routes/ontology/+page.svelte (industry chips, department chips)
			'{#each matrix.industries as ind (ind)}\n<button class="chip">{ind}</button>\n{/each}',
			'{#each matrix.departments as dept (dept)}\n<button>\n{dept}{#if industry && hasSpec(industry, dept)}<span/>{/if}\n</button>\n{/each}',
			// routes/datasets/+page.svelte
			'{#each matrix.industries as ind (ind)}\n<button class="chip" onclick={() => pickIndustry(ind)}>{ind}</button>\n{/each}',
			// block-edit / EntityDeriveBrowser / BlockAuthorAssistant (the <option> shape)
			'{#each ontoMatrix?.industries ?? [] as ind (ind)}<option value={ind}>{ind}</option>{/each}',
			'{#each departments as dep (dep)}<option value={dep}>{dep}</option>{/each}'
		];
		for (const [i, sample] of PRE_FIX.entries()) {
			expect(rawAxisRenders(sample).length, `pattern ${i} does not match its own defect`).toBeGreaterThan(0);
		}
	});

	it('every .svelte in the tree is clean', () => {
		const offenders: string[] = [];
		for (const f of files) {
			const hits = rawAxisRenders(readFileSync(f, 'utf8'));
			for (const h of hits) offenders.push(`${relative(SRC, f)} — ${h}`);
		}
		expect(
			offenders,
			`these render a matrix axis value raw; label the TEXT with industryLabel/departmentLabel ` +
				`and leave every value=/href/query param carrying the enum:\n  ${offenders.join('\n  ')}`
		).toEqual([]);
	});

	it('all five known axis-rendering files import the label module', () => {
		// The scan above proves nothing is raw; this proves the five that DO render an axis are
		// wired to the one module, rather than having grown a local copy each.
		const WIRED = [
			'routes/ontology/+page.svelte',
			'routes/datasets/+page.svelte',
			'routes/block-edit/+page.svelte',
			'lib/components/build/EntityDeriveBrowser.svelte',
			'lib/components/build/BlockAuthorAssistant.svelte'
		];
		for (const rel of WIRED) {
			const src = readFileSync(resolve(SRC, rel), 'utf8');
			expect(src, `${rel} renders an axis but does not import the label module`).toContain(
				"from '$lib/i18n/ontology-axis-label'"
			);
		}
	});

	it('no <option> smuggles a label into its value', () => {
		// ⛔ The half of the <option> fix that breaks submission if someone "tidies" it. The three
		// selects bind their value into `?industry=`/`?department=` and into POST bodies matched
		// against the ontology_entities columns.
		for (const f of files) {
			const src = readFileSync(f, 'utf8');
			expect(src, `${relative(SRC, f)} puts a localized word in an <option value>`).not.toMatch(
				/option value=\{(industryLabel|departmentLabel)\(/
			);
		}
	});
});

describe('routes/ontology/+page.svelte no longer prints the axis raw', () => {
	const route = readFileSync(resolve(process.cwd(), 'src/routes/ontology/+page.svelte'), 'utf8');

	const REGRESSIONS: { site: string; re: RegExp }[] = [
		{ site: 'the industry chips', re: />\{ind\}</ },
		{ site: 'the department chips', re: /^\s*\{dept\}\{#if industry/m },
		{ site: 'the graph header cell', re: /\{industry\} × \{department\}/ },
		{ site: 'the detail-panel scope subtitle', re: /· \{selectedEntity\.scope\}/ }
	];

	for (const { site, re } of REGRESSIONS) {
		it(`${site} does not print the raw value`, () => {
			expect(re.test(route), `${site} renders the seed value verbatim again`).toBe(false);
		});
	}

	it('…and the four patterns are the real pre-fix expressions, not regexes that match nothing', () => {
		// ⛔ NON-VACUITY. A source scan whose patterns never matched anything passes forever. These
		// are byte-for-byte the lines this change replaced (ontology/+page.svelte:506, 515, 526, 596
		// at 037daa1).
		const PRE_FIX = [
			'<button class="chip" class:active={industry === ind} onclick={() => selectIndustry(ind)}>{ind}</button>',
			'\t\t\t\t\t\t\t{dept}{#if industry && hasSpec(industry, dept)}<span class="spec-dot" title={m.ontology_specialized()}>●</span>{/if}',
			'<span class="meta-cell">{industry} × {department}</span>',
			'<div class="detail-sub">{selectedEntity.name} · {selectedEntity.scope}</div>'
		];
		for (const [i, sample] of PRE_FIX.entries()) {
			expect(REGRESSIONS[i]!.re.test(sample), `pattern ${i} does not match its own defect`).toBe(true);
		}
	});

	it('the label functions are imported and actually called', () => {
		expect(route).toContain("from '$lib/i18n/ontology-axis-label'");
		expect(route).toContain('industryLabel(ind)');
		expect(route).toContain('departmentLabel(dept)');
		expect(route).toContain('ontologyScopeLabel(selectedEntity.scope)');
	});

	it('the chip VALUE is still the raw slug — the label never reaches selection or the query', () => {
		// ⛔ The other half of the fix. `selectIndustry`/`selectDepartment` feed `?industry=`/
		// `?department=` on GET /api/ontology, matched against the ontology_entities COLUMNS. A
		// localized value there translates the chips and empties the graph beneath them.
		expect(route).toContain('onclick={() => selectIndustry(ind)}');
		expect(route).toContain('onclick={() => selectDepartment(dept)}');
		expect(route).not.toContain('selectIndustry(industryLabel(');
		expect(route).not.toContain('selectDepartment(departmentLabel(');
		// `hasSpec` keys off the raw cell literals too.
		expect(route).toContain('hasSpec(industry, dept)');
	});

	it('the corrected comment records what was false, rather than quietly disappearing', () => {
		// Repo convention: a comment describing a decision gets CORRECTED IN PLACE with a note about
		// what was actually true, so a future reader meets the history. The old claim must still be
		// legible, and `reloadOnLocaleChange` must still be called (it is what relocalizes the GRAPH).
		expect(route).toContain('Relocalize matrix axis labels + entity/relation graph on locale switch.');
		expect(route).toContain('reloadOnLocaleChange(load);');
		expect(route).toMatch(/CORRECTED/);
	});
});

describe('the work-area vocabulary has exactly one copy', () => {
	const SRC = resolve(process.cwd(), 'src');

	function svelteFiles(dir: string): string[] {
		const out: string[] = [];
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) {
				if (name === 'paraglide' || name === 'node_modules') continue;
				out.push(...svelteFiles(full));
			} else if (name.endsWith('.svelte')) out.push(full);
		}
		return out;
	}

	it('no screen declares its own value→domain_* table', () => {
		// ⛔ THE GUARD THAT WAS MISSING, AND THE ONE THAT MATTERS. Deleting /submit's table proved
		// nothing about /challenges, which kept a THIRD copy — and that was the copy with teeth:
		// `LeaderboardRow` renders `workAreaLabel` for every row an inch below those filter chips,
		// so repointing one entry (`{ v: 'Ops', labelKey: 'domain_ops' }` → `'domain_it'`) put the
		// word "IT" over twenty rows badged "Bedrijfsvoering", with 117 files / 1172 tests green.
		//
		// Asserting `departmentLabel(d) === workAreaLabel(d)` could never have caught it: that
		// equality is true by delegation and says nothing about a table in a route file. This scans
		// for the DECLARATION SHAPE all three copies had.
		const DECL = /labelKey:\s*'domain_/;
		expect(DECL.test("		{ v: 'Claims', labelKey: 'domain_claims' },"), 'pattern does not match its own defect').toBe(true);

		const offenders = svelteFiles(SRC)
			.filter((f) => DECL.test(readFileSync(f, 'utf8')))
			.map((f) => relative(SRC, f));
		expect(
			offenders,
			`these carry a private copy of the work-area vocabulary; import workAreaLabel instead:\n  ${offenders.join('\n  ')}`
		).toEqual([]);
	});

	it('/challenges resolves its chips through the shared module, sentinel aside', () => {
		const ch = readFileSync(resolve(SRC, 'routes/challenges/+page.svelte'), 'utf8');
		expect(ch).toContain("from '$lib/i18n/work-area-label'");
		expect(ch).toContain('workAreaLabel(v)');
		// The values come from the enum, so a ninth work area reaches this filter for free.
		expect(ch).toContain('...WORK_AREAS');
		// ⚠️ …and the sentinel is still handled HERE, not smuggled into workAreaLabel, which
		// documents a deliberate refusal to give it a case.
		expect(ch).toContain('m.domain_all()');
		const wal = readFileSync(resolve(process.cwd(), 'src/lib/i18n/work-area-label.ts'), 'utf8');
		expect(wal, "'All domains' must not become a work area").not.toContain("case 'All domains'");
	});

	it('/submit no longer carries its own DOMAINS table', () => {
		// ⛔ The consolidation. /submit held a second `{ v, labelKey }[]` of the same eight values
		// against the same eight `domain_*` keys, uncovered by the backend-scraping guard in
		// work-area-label.test.ts. The pattern is the literal declaration that was deleted.
		const submit = readFileSync(resolve(process.cwd(), 'src/routes/submit/+page.svelte'), 'utf8');
		const DECL = /const DOMAINS: \{ v: string; labelKey: string \}\[\] = \[/;
		expect(DECL.test('	const DOMAINS: { v: string; labelKey: string }[] = ['), 'pattern does not match its own defect').toBe(true);
		expect(DECL.test(submit), '/submit declared its own DOMAINS table again').toBe(false);
		expect(submit).toContain("from '$lib/i18n/work-area-label'");
		expect(submit).toContain('workAreaLabel(d)');
		// The `mm` cast that defeated paraglide's tree-shake existed only for those two sites.
		// ⚠️ LINE-ANCHORED, not a substring: the note left in /submit explaining the deletion quotes
		// the declaration, and a `toContain` check reddens on the prose that documents the fix.
		const MM_DECL = /^\s*const mm = m as unknown as/m;
		expect(MM_DECL.test('\tconst mm = m as unknown as Record<string, (i?: Record<string, unknown>) => string>;'), 'pattern does not match its own defect').toBe(true);
		expect(MM_DECL.test(submit), '/submit re-declared the `mm` messages cast').toBe(false);
		expect(submit).toContain('const mm = m as unknown as'); // …but the explanatory note is still there
	});

	it('the select still submits the ENUM, not the translated word', () => {
		const submit = readFileSync(resolve(process.cwd(), 'src/routes/submit/+page.svelte'), 'utf8');
		expect(submit).toContain('<option value={d}>');
		expect(submit).not.toContain('<option value={workAreaLabel(');
	});
});
