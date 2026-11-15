// src/lib/i18n/copy-style.test.ts — enforces the mechanical half of docs/style-guide.md on the
// member-facing message catalog. The readers are business people, not developers: headings are
// nouns, nobody says "Hi", strings stay short, and no developer jargon reaches them.
//
// ⛔ WHY A CATALOG TEST. The copy defects this pins ("What's worth voting on this week?",
// "Hi — tell me…", "Sandbox: isolated · mock data") were all STRINGS, not code paths. A render test
// would only prove the page picked the key; only this proves the key says something acceptable.
//
// ⚠️ The exemption lists below are explicit on purpose. Adding to one should be a visible,
// reviewed decision, never a side effect.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NAV_ITEMS } from '$lib/layout/navConfig';

const dir = resolve(process.cwd(), 'messages');

/** Prefixes whose strings a member (non-technical business user) reads. Round 2 (2026-10-15)
 *  added the Library screens (Building blocks, Sample data — and Connectors/Ontology, which
 *  developers in a tenant read, and they are business users too), the flow/block test surfaces,
 *  the voting cycle, information requests and the API errors (`error-message.ts`, shown on every
 *  screen). All of them get the word caps as well. */
const MEMBER_PREFIXES = [
	'home_', 'nav_', 'challenges_', 'challenge_', 'submit_', 'solutions_', 'solution_',
	'winner_', 'build_', 'nodecfg_', 'console_', 'chat_', 'docs_',
	'datasets_', 'dataset_', 'connectors_', 'ontology_', 'blocks_', 'flow_', 'blocksim_',
	'blockauthor_', 'cycle_', 'cadence_', 'requests_', 'error_'
] as const;

/**
 * Prefixes whose strings are not page copy but still RENDER ON MEMBER PAGES: run/test errors
 * (`blockerr_`, the Result panel on /build via `block-test-error-label.ts`) and the run-failure
 * hints the assistant reuses (`blockresult_errkind_`, `agent-chat.svelte.ts`). They get the
 * jargon, greeting and question-title rules in every locale; NOT the word caps.
 */
const MEMBER_RENDERED_PREFIXES = ['blockerr_', 'blockresult_errkind_'] as const;

const LOCALES = ['en', 'nl', 'pl', 'fr', 'es', 'de', 'ar', 'he'] as const;
type Locale = (typeof LOCALES)[number];

/** Locales whose member copy is word-capped. en is the base; nl is the second working language
 *  and the one the owner reads. The other six carry the en meaning and are not counted — word
 *  counts are not comparable across languages (fr/es run long, de compounds run short). */
const WORD_CAP_LOCALES = ['en', 'nl'] as const;

/** Nav labels of items only admins see are read by technical staff ("LLM settings",
 *  "Sandboxes"). DERIVED from navConfig rather than hand-listed, so a nav item that becomes
 *  member-visible is checked the moment its role gate is removed. `developer` is NOT exempt:
 *  developers in a tenant are still business users. */
const ADMIN_ONLY_NAV_KEYS = new Set(
	NAV_ITEMS.filter((i) => i.requiresRole === 'super_admin' || i.requiresRole === 'tenant_admin').map(
		(i) => i.labelKey
	)
);

/** Title-ish keys that may legitimately end in "?" (a confirmation asks a real question).
 *  Empty today; add a key here only for a genuine yes/no confirmation. */
const QUESTION_TITLE_ALLOWLIST = new Set<string>([]);

/** Member-prefixed keys that are read only by admins and may name the technical thing.
 *  Each entry carries its reason. */
const JARGON_ALLOWLIST = new Set<string>([
	// Not a sidebar label (the sidebar renders `nav_byo_keys`). Composed into the budget
	// notification that only tenant admins receive (`notification-label.ts` budgetHowTo).
	'nav_llm_settings',
	// A file FORMAT the reader picks or uploads. "JSON" here is the name on the file, not jargon
	// about our internals; renaming it would leave the reader unable to match it to their file.
	'error_unsupported_file_type',
	'error_unsupported_file_type_no_extension',
	'error_storage_format_unknown',
	// Same reason, on the Sample data screen (prefix in scope since round 2): the upload hint and
	// paste placeholder list the formats the file picker accepts, and the source badge names the
	// format the data came in as.
	'datasets_upload_hint',
	'datasets_paste_placeholder',
	'dataset_source_json',
	// The connector SQL/JSON source editors (/connectors, tenant_admin): the reader pasted JSON.
	'error_sql_empty',
	'error_sql_json_invalid',
	'error_json_invalid',
	// The plan editor's BYO-mode field (/admin/plans, super_admin only).
	'error_byo_mode_required',
	'error_byo_mode_fixed_by_plan'
]);

/** Strings allowed past the word cap, each with its reason. Empty today. */
const WORD_CAP_ALLOWLIST = new Set<string>([]);

const TITLE_CAP = 8;
const BODY_CAP = 20;
/** Long-form paragraphs on the /docs page (`docs_<section>_p1`). They ARE the explanation. */
const DOCS_PARAGRAPH_CAP = 40;

const GREETING = /\b(hi|hoi|hello|hallo|hey)\b/i;
const JARGON: Array<[string, RegExp]> = [
	['JSON', /\bjson\b/i],
	['sandbox', /\bsandbox\w*/i],
	['upstream', /\bupstream\b/i],
	['mock data', /\bmock[\s-]?data\b/i],
	['LLM', /\bllms?\b/i],
	['console', /\bconsole\b/i],
	['payload', /\bpayloads?\b/i],
	['schema', /\bschema('?s)?\b/i],
	// Round 2: the data-modelling words the Library screens used to show members.
	['PII', /\bpii\b/i],
	['cardinality', /\bcardinalit\w*/i],
	['materialize', /\bmateriali[sz]\w*/i]
];

/**
 * Rule 3 — no "you/your" in a heading: a heading names the thing. Per locale, only where the
 * second-person forms are separate words (ar/he mark the person with affixes, not words).
 * ⚠️ de `Sie`/`Ihr` match CASE-SENSITIVELY: lowercase `sie`/`ihr` mean she/they/her.
 */
const SECOND_PERSON: Partial<Record<Locale, RegExp>> = {
	en: /\b(you|your|yours|yourself)\b/i,
	nl: /(?<![\p{L}])(je|jouw|jij|jullie|u|uw)(?![\p{L}])/iu,
	de: /(?<![\p{L}])(du|dein\p{L}*|Sie|Ihr\p{L}*|Ihnen|dich|dir)(?![\p{L}])/u,
	fr: /(?<![\p{L}])(vous|votre|vos|ton|ta|tes|tu)(?![\p{L}])/iu,
	es: /(?<![\p{L}])(tu|tus|usted\p{L}*|vuestr\p{L}*)(?![\p{L}])/iu,
	pl: /(?<![\p{L}])(twój|twoj\p{L}*|wasz\p{L}*)(?![\p{L}])/iu
};

/**
 * Rule 8 — an error says what failed and what to do: no apology, no "please", no "we couldn't".
 * Per locale, the phrases that ARE the apology or the plea there. ⚠️ he matches `לא הצלחנו`
 * ("we didn't manage") and `אנא`, NOT `בבקשה`, which also means "in the request" (`error_validation`).
 */
const APOLOGY: Record<Locale, RegExp> = {
	en: /\b(we couldn['’]t|we could not|we can['’]t|we cannot|we were unable|please|sorry|apologi[sz]e)\b/i,
	nl: /(?<![\p{L}])(helaas|sorry|alsjeblieft|alstublieft|excuses|we konden)(?![\p{L}])/iu,
	de: /(?<![\p{L}])(bitte|leider|entschuldigung|wir konnten|wir können)(?![\p{L}])/iu,
	fr: /(veuillez|désolé|merci de|s['’]il vous plaît|nous n['’]avons pas pu|nous ne pouvons pas)/iu,
	es: /(por favor|lo sentimos|no pudimos|no podemos|lamentablemente)/iu,
	pl: /(proszę|przepraszamy|niestety|nie udało nam się|nie możemy)/iu,
	ar: /(يرجى|الرجاء|عذرًا|عذرا|نأسف|من فضلك|لم نتمكن|لا يمكننا)/u,
	he: /(אנא|מצטערים|לא הצלחנו|איננו יכולים|אין באפשרותנו)/u
};

/** Rule 9 — native business Dutch says "je", never the formal "u/uw". `{count}u` / `1u` is the
 *  hour abbreviation, so a digit or `}` right before the `u` does not count. */
const FORMAL_DUTCH = /(?<![\p{L}\p{N}}])(u|uw|uzelf)(?![\p{L}])/iu;

const isMember = (k: string) => MEMBER_PREFIXES.some((p) => k.startsWith(p));
/** Scope of rule 3: a heading or title — not the hero's lede, which is body text. */
const isHeading = (k: string) => /_(title|heading)(_|$)/.test(k);
const isMemberRendered = (k: string) =>
	isMember(k) || MEMBER_RENDERED_PREFIXES.some((p) => k.startsWith(p));
/** Scope of the "no question" rule: anything that renders as a heading or hero line. */
const isTitle = (k: string) => /_(title|heading|hero)(_|$)/.test(k);
/** Scope of the title word cap: the heading itself, not the hero's lede or buttons. */
const isCappedTitle = (k: string) => /_(title|heading)$/.test(k);
const isDocsParagraph = (k: string) => /^docs_.*_p\d+$/.test(k);

/** All renderable text of a value — plain strings, or every variant of a plural message. */
function texts(v: unknown): string[] {
	if (typeof v === 'string') return [v];
	if (Array.isArray(v)) return v.flatMap(texts);
	if (v && typeof v === 'object') {
		const o = v as Record<string, unknown>;
		return 'match' in o ? texts(o.match) : Object.values(o).flatMap(texts);
	}
	return [];
}

const words = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

function load(locale: string): Record<string, unknown> {
	const raw = readFileSync(resolve(dir, `${locale}.json`), 'utf8');
	expect(raw.trim().length).toBeGreaterThan(0);
	const obj = JSON.parse(raw) as Record<string, unknown>;
	return obj;
}

function memberEntries(obj: Record<string, unknown>): Array<[string, string]> {
	return Object.entries(obj)
		.filter(([k]) => isMember(k))
		.flatMap(([k, v]) => texts(v).map((t) => [k, t] as [string, string]));
}

/** Page copy AND the error strings rendered on member pages — the scope of the jargon,
 *  greeting and question rules. */
function memberRenderedEntries(obj: Record<string, unknown>): Array<[string, string]> {
	return Object.entries(obj)
		.filter(([k]) => isMemberRendered(k))
		.flatMap(([k, v]) => texts(v).map((t) => [k, t] as [string, string]));
}

/** EVERY string in the catalog — the scope of rules 3, 8 and 9, which hold on admin screens too. */
function allEntries(obj: Record<string, unknown>): Array<[string, string]> {
	return Object.entries(obj)
		.filter(([k]) => k !== '$schema')
		.flatMap(([k, v]) => texts(v).map((t) => [k, t] as [string, string]));
}

function secondPersonHeadings(entries: Array<[string, string]>, locale: Locale) {
	const re = SECOND_PERSON[locale];
	return re ? entries.filter(([k, t]) => isHeading(k) && re.test(t)).map(([k, t]) => `${k}: "${t}"`) : [];
}
function apologies(entries: Array<[string, string]>, locale: Locale) {
	return entries.filter(([, t]) => APOLOGY[locale].test(t)).map(([k, t]) => `${k}: "${t}"`);
}
function formalDutch(entries: Array<[string, string]>) {
	return entries.filter(([, t]) => FORMAL_DUTCH.test(t)).map(([k, t]) => `${k}: "${t}"`);
}

function questionTitles(entries: Array<[string, string]>) {
	return entries.filter(([k, t]) => isTitle(k) && t.includes('?') && !QUESTION_TITLE_ALLOWLIST.has(k));
}
function greetings(entries: Array<[string, string]>) {
	return entries.filter(([, t]) => GREETING.test(t));
}
function jargon(entries: Array<[string, string]>) {
	return entries
		.filter(([k]) => !ADMIN_ONLY_NAV_KEYS.has(k) && !JARGON_ALLOWLIST.has(k))
		.flatMap(([k, t]) => JARGON.filter(([, re]) => re.test(t)).map(([term]) => `${k}: ${term} in "${t}"`));
}
function overCap(entries: Array<[string, string]>) {
	return entries
		.filter(([k]) => !WORD_CAP_ALLOWLIST.has(k))
		.filter(([k, t]) => words(t) > (isCappedTitle(k) ? TITLE_CAP : isDocsParagraph(k) ? DOCS_PARAGRAPH_CAP : BODY_CAP))
		.map(([k, t]) => `${k} (${words(t)} words)`);
}

describe('copy style — en (docs/style-guide.md)', () => {
	const en = load('en');
	const entries = memberEntries(en);

	it('the catalog is non-empty and the member-facing set is substantial', () => {
		expect(Object.keys(en).length).toBeGreaterThan(500);
		// Non-vacuity: a renamed prefix or an empty filter would make every rule below pass.
		expect(entries.length).toBeGreaterThan(300);
		expect(entries.some(([k]) => k === 'home_hero_title')).toBe(true);
	});

	it('admin-only nav exemption is derived and non-empty, and never covers a member item', () => {
		expect(ADMIN_ONLY_NAV_KEYS.size).toBeGreaterThan(3);
		for (const k of ['nav_home', 'nav_challenges', 'nav_solutions', 'nav_build']) {
			expect(ADMIN_ONLY_NAV_KEYS.has(k)).toBe(false);
		}
	});

	it('titles are nouns, not questions', () => {
		expect(questionTitles(entries)).toEqual([]);
	});

	it('no greetings', () => {
		expect(greetings(entries)).toEqual([]);
	});

	it('no developer jargon', () => {
		expect(jargon(entries)).toEqual([]);
	});
});

describe.each(WORD_CAP_LOCALES)('copy style — %s word caps', (locale) => {
	const entries = memberEntries(load(locale));
	it('the member-facing set is substantial and includes the round-2 prefixes', () => {
		expect(entries.length).toBeGreaterThan(800);
		for (const p of ['error_', 'datasets_', 'blocks_', 'cycle_', 'requests_']) {
			expect(entries.some(([k]) => k.startsWith(p)), p).toBe(true);
		}
	});
	it(`titles ≤ ${TITLE_CAP}, body ≤ ${BODY_CAP}, docs paragraphs ≤ ${DOCS_PARAGRAPH_CAP}`, () => {
		expect(overCap(entries)).toEqual([]);
	});
});

// Rules 3, 8 and 9 hold for the WHOLE catalog, admin screens included: an apology or a formal
// "u" is no more acceptable on /tenants than on /challenges.
describe.each(LOCALES)('copy style — %s (rules 3, 8, 9 over the whole catalog)', (locale) => {
	const entries = allEntries(load(locale));
	it('the catalog is non-empty', () => {
		// Non-vacuity: an empty or unparsed catalog would pass every rule below.
		expect(entries.length).toBeGreaterThan(2000);
		expect(entries.some(([k]) => k === 'error_load_failed')).toBe(true);
	});
	it('rule 3: no "you/your" in headings', () => {
		expect(secondPersonHeadings(entries, locale)).toEqual([]);
	});
	it('rule 8: no apologies and no "please"', () => {
		expect(apologies(entries, locale)).toEqual([]);
	});
	it.runIf(locale === 'nl')('rule 9: "je", never the formal "u/uw"', () => {
		expect(formalDutch(entries)).toEqual([]);
	});
});

// ⛔ ALL EIGHT LOCALES, NOT en + nl. The jargon this list names is Latin-script and untranslated
// (JSON, LLM, sandbox, payload…), so the same patterns hold in pl/fr/es/de/ar/he — and those were
// exactly where it survived: "LLM-Budget", "{slug} … nie deklaruje uprawnienia llm".
describe.each(LOCALES)('copy style — %s (greeting, jargon, question titles)', (locale) => {
	const cat = load(locale);
	const entries = memberRenderedEntries(cat);

	it('the member-rendered set is substantial and includes the error strings', () => {
		// Non-vacuity: a renamed prefix or an empty filter would make every rule below pass.
		expect(entries.length).toBeGreaterThan(500);
		expect(entries.some(([k]) => k.startsWith('error_'))).toBe(true);
		expect(entries.some(([k]) => k.startsWith('blockerr_'))).toBe(true);
	});
	it('titles are nouns, not questions', () => {
		expect(questionTitles(entries)).toEqual([]);
	});
	it('no greetings', () => {
		expect(greetings(entries)).toEqual([]);
	});
	it('no developer jargon', () => {
		expect(jargon(entries)).toEqual([]);
	});
});

describe('copy style — the rules catch what they claim to', () => {
	// Each rule must go red on the strings that motivated it; otherwise a green run means nothing.
	it('flags the retired strings', () => {
		expect(questionTitles([['home_hero_title', "What's worth voting on this week?"]])).toHaveLength(1);
		expect(greetings([['chat_intro', 'Hi — tell me what you want to build']])).toHaveLength(1);
		expect(greetings([['chat_intro', 'Hoi — vertel me wat je wilt bouwen']])).toHaveLength(1);
		expect(jargon([['build_sandbox_pill', 'Sandbox: isolated · mock data']])).toHaveLength(2);
		expect(jargon([['build_sandbox_pill', 'Sandbox: geïsoleerd · mockdata']])).toHaveLength(2);
		expect(jargon([['console_trace_cost', '{calls} LLM-aanroepen']])).toHaveLength(1);
		// The strings this lane fixed, as they read before — the error prefixes are in scope now.
		expect(memberRenderedEntries({ error_sandbox_busy: 'Your sandbox is already running another flow.' })).toHaveLength(1);
		expect(jargon([['error_sandbox_busy', 'Your sandbox is already running another flow.']])).toHaveLength(1);
		expect(jargon([['blockresult_errkind_budget_exhausted', 'Das LLM-Budget dieses Arbeitsbereichs ist aufgebraucht.']])).toHaveLength(1);
		expect(overCap([['submit_title', 'one two three four five six seven eight nine']])).toHaveLength(1);
		expect(overCap([['submit_lede', Array(21).fill('w').join(' ')]])).toHaveLength(1);
		// Round 2: the strings rules 3, 8 and 9 were added for, as they read before.
		expect(secondPersonHeadings([['license_blocked_heading_setup', 'Your access is being set up']], 'en')).toHaveLength(1);
		expect(secondPersonHeadings([['admin_keys_new_title', 'Kopieer nu je nieuwe sleutel']], 'nl')).toHaveLength(1);
		expect(secondPersonHeadings([['no_workspace_heading', 'Sie haben noch keinen Zugang']], 'de')).toHaveLength(1);
		expect(apologies([['error_load_failed', 'We couldn’t load that. Please try again.']], 'en')).toHaveLength(1);
		expect(apologies([['error_load_failed', "We couldn't load that."]], 'en')).toHaveLength(1);
		expect(apologies([['confirm_title', 'Bitte bestätigen']], 'de')).toHaveLength(1);
		expect(apologies([['error_load_failed', 'Impossible de charger. Veuillez réessayer.']], 'fr')).toHaveLength(1);
		expect(apologies([['error_load_failed', 'تعذّر التحميل. يرجى المحاولة مرة أخرى.']], 'ar')).toHaveLength(1);
		expect(apologies([['error_load_failed', 'לא הצלחנו לטעון את הנתונים.']], 'he')).toHaveLength(1);
		expect(apologies([['x', 'Helaas, dat lukte niet.']], 'nl')).toHaveLength(1);
		expect(formalDutch([['error_tenant_suspended', 'Neem contact op met uw beheerder.']])).toHaveLength(1);
		expect(formalDutch([['llmset_byo_locked', 'dus u kunt hier geen sleutel toevoegen']])).toHaveLength(1);
		expect(jargon([['datasets_col_pii', 'PII']])).toHaveLength(1);
		expect(jargon([['ontology_field_cardinality', 'Cardinality']])).toHaveLength(1);
		expect(jargon([['connectors_subtitle', 'The host fetches and materializes the data']])).toHaveLength(1);
	});
	it('does not flag clean copy', () => {
		expect(questionTitles([['submit_title', 'Submit a challenge']])).toEqual([]);
		expect(greetings([['home_hero_lede', 'Report bottlenecks and vote on priorities.']])).toEqual([]);
		expect(jargon([['build_sandbox_pill', 'Test environment · sample data']])).toEqual([]);
		// The hour abbreviation is not the formal "u"; "je" in body text is fine; a heading that
		// names the thing passes; a lede is body text; "in the request" in Hebrew is not "please".
		expect(formalDutch([['timeago_hour', '{count}u geleden'], ['mkt', '1u vibe-coding'], ['x', 'Neem contact op met je beheerder.']])).toEqual([]);
		expect(secondPersonHeadings([['license_blocked_heading_setup', 'Toegang wordt ingericht']], 'nl')).toEqual([]);
		expect(secondPersonHeadings([['home_hero_lede', 'Your access is being set up']], 'en')).toEqual([]);
		expect(apologies([['error_validation', 'חלק מהפרטים בבקשה הזו אינם תקינים.']], 'he')).toEqual([]);
		expect(apologies([['error_load_failed', 'Could not load. Try again.']], 'en')).toEqual([]);
	});
});

describe('copy that must not point at things that do not exist', () => {
	// ⛔ The LLM settings page moved under the settings gear (Settings → Organisation → LLM
	// settings); these sentences spelled "Administer → LLM settings" out per catalog and kept
	// pointing at a retired menu. Each now takes `{path}`, built from the shell's own labels by
	// `llm-settings-path.ts`, so a menu change cannot strand them again.
	const PATH_KEYS = [
		'notification_budget_how_to',
		'blockerr_llm_budget_exhausted',
		'blockresult_errkind_budget_exhausted',
		'error_llm_byo_key_required',
		'error_llm_platform_local_only',
		'blockerr_llm_byo_key_required',
		'blockerr_llm_platform_local_only'
	];
	it.each(LOCALES)('%s: every LLM-settings sentence takes {path} and spells out no menu', (locale) => {
		const cat = load(locale);
		for (const k of PATH_KEYS) {
			const t = String(cat[k]);
			expect(t, `${locale}.${k}`).toContain('{path}');
			expect(t, `${locale}.${k} still names the retired menu`).not.toContain(String(cat.nav_group_administer));
		}
	});

	// ⛔ "Pick a template / Reuse a published solution" was once a plain link to /solutions, when no
	// flow-template mechanism existed, and this guard pinned the card to "Browse solutions". Flow
	// templates now exist (0108) and the card opens the template gallery
	// (build-page.flow-templates.test.ts pins that wiring), so the card must name a template — and
	// must still not promise "reuse", which is what "Use as starting point" on a solution does.
	it.each(LOCALES)('%s: the empty-canvas template card names a template and promises no reuse', (locale) => {
		const cat = load(locale);
		const template: Record<string, RegExp> = {
			en: /template/i,
			nl: /sjabloon/i,
			pl: /szablon/i,
			fr: /modèle/i,
			es: /plantilla/i,
			de: /vorlage/i,
			ar: /قالب/,
			he: /תבנית/
		};
		const reuse: Record<string, RegExp> = {
			en: /reuse/i,
			nl: /hergebruik/i,
			pl: /ponownie/i,
			fr: /réutilis/i,
			es: /reutiliz/i,
			de: /wiederverwend/i,
			ar: /أعد استخدام/,
			he: /שימוש חוזר/
		};
		expect(String(cat.build_start_template), `${locale}.build_start_template`).toMatch(template[locale]!);
		for (const k of ['build_start_template', 'build_start_template_sub']) {
			expect(String(cat[k]), `${locale}.${k}`).not.toMatch(reuse[locale]!);
		}
	});
});
