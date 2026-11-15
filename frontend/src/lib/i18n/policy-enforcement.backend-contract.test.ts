// src/lib/i18n/policy-enforcement.backend-contract.test.ts — A RAIL MAY NOT CLAIM AN ENFORCEMENT IT
// DOES NOT HAVE.
//
// ⛔ THE DEFECT THIS WOULD HAVE CAUGHT. /governance was headed "Policy rails · enforced at the
// boundary" — `governance_title`, in all eight catalogs — over EIGHTEEN rails. FOUR of them are
// enforced by nothing at all: `models.code_exec_outside_blocks`, `data.block_prod_data`,
// `data.cross_sandbox_isolation` and `data.eu_only` parse into GovernanceSnapshot fields
// (`codeExecOutsideBlocks`, `blockProdData`, `crossSandboxIsolation`, `euOnly`) that NOTHING in
// backend/src, backend/tests or backend/scripts ever reads. Meanwhile their catalog copy promised,
// in eight languages, that "arbitrary code/eval is banned at save time and refused at run time"
// (`policy_desc_models_code_exec_outside_blocks`) and that sandboxes are fed "by the nightly job"
// (`policy_desc_data_block_prod_data`) — a job that does not exist.
//
// So the contract has two halves and BOTH are needed:
//   • the CLASSIFICATION must match the code — `enforcement: 'enforced'` iff the rail's snapshot
//     field has a real consumer, and `'retired'` iff `buildSnapshot` does not even parse the row;
//   • the WORDS must match the classification — a description that claims an enforcement, in
//     English or in Dutch, has to belong to a rail that really refuses something.
// Either half alone is satisfiable by a lie: a truthful classification under lying copy, or honest
// copy over a classification nobody checked.
//
// ⛔ THE CONSUMER SET IS DERIVED FROM SOURCE, NEVER HAND-LISTED. A hand-listed set is correct on the
// day it is written and silently omits the field added tomorrow — which is how four unenforced
// rails survived every review since Session 6. This scans every `.ts` under `backend/src` for a
// property READ of the field, with comments AND string literals removed, so neither the comment in
// `run-policy.ts` that describes these very fields nor a quoted `'snapshot.euOnly'` in prose can
// satisfy it.
//
// backend/ and frontend/ are two separate Bun projects — no workspaces, no shared package, no
// codegen — so this walks BACKEND SOURCE TEXT on disk with plain `fs`, exactly as
// `policy-label.backend-contract.test.ts` and `api/error-message.backend-contract.test.ts` already
// do. It lives beside `policy-label.ts` because the catalog half of the contract is here.
//
// ⚠️ THE BOUNDARIES, STATED. (1) The claim lexicon is EN + NL only — the two languages a reader of
// this repo can actually check, and `nl` is the demo language. A German translator who introduces
// "verweigert" into an architectural rail is not caught here; the classification half still is.
// (2) A consumer reached by DESTRUCTURING (`const { euOnly } = snapshot`) is invisible to the
// property-read scan. That fails in the LOUD direction — the rail is classified `'enforced'`, no
// `.field` read is found, and this file goes red naming the field — never in the quiet one.
// (3) ⛔ THE REFUSAL SCAN IS A NEAR-MISS DETECTOR, NOT A PROOF OF ABSENCE, and the difference is
// the whole reason the fourth kind exists. "Has a consumer" was the only question this file asked,
// and three rails answered YES while refusing nothing at all: `promotion.staging_canary_pct`
// ASSIGNS `rollout_pct`, `models.work_tiers` PICKS a model, `models.pricing` PRICES a finished
// call. `refusalReads()` closes that gap by asking a second question — is the read lexically
// INSIDE a guard that ends in a refusal? — and it is deliberately generous, because for the
// `'applied'` rule a false POSITIVE only reddens this file (loud) while a false negative would let
// a real boundary be filed under a band that says nothing is refused (quiet).
//     WHAT IT DOES NOT PROVE: a ZERO here is NOT "this rail refuses nothing". It is "no refusal
// appears in the guard span of any read of this field". Rails that genuinely refuse DO score zero —
// through an ALIASED read (the refusal fires on a local, outside the span) or a STATE-MEDIATED one
// (the read writes state and something else refuses on that state later, in another file, on
// another request). Every such rail is named with its measured reason in
// `REFUSAL_SCAN_BLIND_SPOTS` below, and a test DERIVES the rule that no enforced rail may be an
// unexplained zero — so the boundary cannot go stale as rails are added.
// So `'enforced'` is NOT asserted from this scanner (its old consumer rule is untouched); only
// `'applied'` is, and `'applied'` therefore rests on a HUMAN judgement recorded per entry in
// `policy-enforcement.ts`. This scanner is the RATCHET on that judgement: the day somebody puts a
// throw beside one of those three reads, the rail may no longer call itself a setting.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const BACKEND = fileURLToPath(new URL('../../../../backend', import.meta.url));
const BACKEND_SRC = join(BACKEND, 'src');
const SEED = join(BACKEND, 'src', 'db', 'seed-platform.ts');
const STORE = join(BACKEND, 'src', 'host', 'policy-store.ts');
const CLASSIFICATION = join(BACKEND, 'src', 'host', 'policy-enforcement.ts');
const SERVER = join(BACKEND, 'src', 'server.ts');
const MIGRATIONS = join(BACKEND, 'migrations');

/** The two files that may not count as consumers: the parser that CREATES the fields, and the
 *  classification that NAMES them. Both mention every field by construction. */
const NOT_A_CONSUMER = [STORE, CLASSIFICATION];

const enCatalog = JSON.parse(
	readFileSync(fileURLToPath(new URL('../../../messages/en.json', import.meta.url)), 'utf8')
) as Record<string, string>;
const nlCatalog = JSON.parse(
	readFileSync(fileURLToPath(new URL('../../../messages/nl.json', import.meta.url)), 'utf8')
) as Record<string, string>;

// ---------------------------------------------------------------- the strippers

/**
 * TypeScript source with comments removed AND every string/template literal emptied.
 *
 * ⛔ EMPTYING THE STRINGS IS THE POINT, NOT TIDINESS. `policy-enforcement.ts` contains
 * `field: 'blockProdData'` and `run-policy.ts`'s header names all four unenforced rails in prose.
 * A scan that reads either reports a consumer for a field nobody consumes — a guard answering GREEN
 * for precisely the condition it exists to catch. Comments go first for the reason
 * `$lib/test/source-scan.ts` documents at length: a `/*` inside a `//` line, or a `//` inside a
 * string, makes a three-regex version swallow whole files.
 *
 * Newlines survive, so a `file:line` in a failure message still points at the right line.
 */
export function stripCommentsAndStrings(src: string): string {
	let out = '';
	let i = 0;
	while (i < src.length) {
		const c = src[i]!;
		const next = src[i + 1];
		if (c === '/' && next === '/') {
			while (i < src.length && src[i] !== '\n') i++;
			continue;
		}
		if (c === '/' && next === '*') {
			i += 2;
			while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
				if (src[i] === '\n') out += '\n';
				i++;
			}
			i += 2;
			continue;
		}
		if (c === "'" || c === '"' || c === '`') {
			const quote = c;
			out += quote;
			i++;
			while (i < src.length && src[i] !== quote) {
				if (src[i] === '\\') {
					i += 2;
					continue;
				}
				if (src[i] === '\n') out += '\n';
				i++;
			}
			out += quote;
			i++;
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

/** Comments only — used where a string literal is the thing being read (`by.get('…')`). */
function stripComments(src: string): string {
	let out = '';
	let i = 0;
	while (i < src.length) {
		if (src[i] === '/' && src[i + 1] === '/') {
			while (i < src.length && src[i] !== '\n') i++;
			continue;
		}
		if (src[i] === '/' && src[i + 1] === '*') {
			i += 2;
			while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
				if (src[i] === '\n') out += '\n';
				i++;
			}
			i += 2;
			continue;
		}
		out += src[i];
		i++;
	}
	return out;
}

function listTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) out.push(...listTsFiles(p));
		else if (entry.endsWith('.ts')) out.push(p);
	}
	return out;
}

// ---------------------------------------------------------------- backend readers

/** The text between `open` and its matching close bracket, exclusive. */
function balanced(src: string, startIdx: number, open: '[' | '{'): string {
	const close = open === '[' ? ']' : '}';
	let depth = 0;
	for (let i = startIdx; i < src.length; i++) {
		if (src[i] === open) depth++;
		else if (src[i] === close) {
			depth--;
			if (depth === 0) return src.slice(startIdx + 1, i);
		}
	}
	throw new Error(`unbalanced ${open} from index ${startIdx}`);
}

/** The literal after a `field:` label, any quote style — the same measured double-quote/backtick
 *  hole `policy-label.backend-contract.test.ts` documents on its own scrapers. */
function fieldLiteral(chunk: string, field: string): string | undefined {
	return chunk.match(new RegExp(`\\b${field}:\\s*(['"\`])([^'"\`]+)\\1`))?.[2];
}

/** One `{ … }` object literal per entry of the seeder's POLICIES array. */
function seedPolicyObjects(): string[] {
	const src = readFileSync(SEED, 'utf8');
	const decl = 'const POLICIES: NewPolicy[] = [';
	const at = src.indexOf(decl);
	if (at === -1) throw new Error('POLICIES array not found in backend/src/db/seed-platform.ts');
	// The LAST `[` of the declaration: `NewPolicy[]` is an empty pair `balanced` would "match".
	const body = balanced(src, at + decl.length - 1, '[');
	const objects: string[] = [];
	for (let i = 0; i < body.length; i++) {
		if (body[i] === '{') {
			const obj = balanced(body, i, '{');
			objects.push(obj);
			i += obj.length + 1;
		}
	}
	return objects;
}

/** Policy keys INSERTed by a migration — `models.work_tiers` (0045) and `models.pricing` (0053)
 *  are in NO TypeScript array and are exactly the pair a hand-copied list drops. */
function migrationPolicyKeys(): string[] {
	const keys: string[] = [];
	for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))) {
		const src = readFileSync(join(MIGRATIONS, f), 'utf8').replace(/--[^\n]*/g, '');
		for (const stmt of src.split(/INSERT\s+INTO\s+policies/i).slice(1)) {
			const valuesAt = stmt.search(/\bVALUES\b/i);
			if (valuesAt === -1) continue;
			for (const r of stmt.slice(valuesAt).matchAll(/\(\s*(?:'([^']+)'|\$\$([^$]+)\$\$)/g)) {
				const k = r[1] ?? r[2];
				if (k) keys.push(k);
			}
		}
	}
	return keys;
}

const seedObjects = seedPolicyObjects();
const seedKeys = seedObjects.map((o) => fieldLiteral(o, 'key')).filter(Boolean) as string[];
const backendPolicyKeys = [...seedKeys, ...migrationPolicyKeys()];

/** The seeder's own English `description:` per policy — the prose that lands in the DB row and on
 *  the wire, and therefore what an OLD frontend renders during a roll. */
const seedDescriptionByKey = new Map<string, string>();
for (const o of seedObjects) {
	const key = fieldLiteral(o, 'key');
	// Descriptions wrap onto their own line and may contain apostrophes escaped as ’.
	const desc = o.match(/\bdescription:\s*\n?\s*(['"`])([\s\S]*?)\1\s*,/)?.[2];
	if (key && desc) seedDescriptionByKey.set(key, desc);
}

/** `POLICY_ENFORCEMENT` from backend/src/host/policy-enforcement.ts, as {key → {enforcement, field}}. */
function classification(): Map<string, { enforcement: string; field: string | null }> {
	const src = readFileSync(CLASSIFICATION, 'utf8');
	const decl = 'export const POLICY_ENFORCEMENT: Record<string, PolicyEnforcementEntry> = {';
	const at = src.indexOf(decl);
	if (at === -1) throw new Error('POLICY_ENFORCEMENT not found in host/policy-enforcement.ts');
	const raw = balanced(src, at + decl.length - 1, '{');
	// Comments in this map quote policy keys constantly; entries are matched on the stripped copy so
	// a key named in a `//` note cannot become an entry of its own.
	const body = stripComments(raw);
	const out = new Map<string, { enforcement: string; field: string | null }>();
	for (const m of body.matchAll(/(['"`])([a-z_]+\.[a-z_]+)\1\s*:\s*\{/g)) {
		const key = m[2]!;
		const entry = balanced(body, m.index! + m[0].length - 1, '{');
		const enforcement = fieldLiteral(entry, 'enforcement');
		if (!enforcement) throw new Error(`no enforcement literal for ${key}`);
		out.set(key, { enforcement, field: fieldLiteral(entry, 'field') ?? null });
	}
	return out;
}
const CLASSIFIED = classification();

/** The declared field names of `GovernanceSnapshot`. */
function snapshotFields(): string[] {
	const src = stripCommentsAndStrings(readFileSync(STORE, 'utf8'));
	const decl = 'export interface GovernanceSnapshot {';
	const at = src.indexOf(decl);
	if (at === -1) throw new Error('GovernanceSnapshot not found in host/policy-store.ts');
	const body = balanced(src, at + decl.length - 1, '{');
	return [...body.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:/gm)].map((x) => x[1]!);
}
const SNAPSHOT_FIELDS = new Set(snapshotFields());

/** The policy keys `buildSnapshot()` actually parses — `by.get('<key>')`, read from that FUNCTION
 *  BODY only, so a mention elsewhere in the module cannot count. */
function parsedPolicyKeys(): Set<string> {
	const src = readFileSync(STORE, 'utf8');
	const decl = 'export function buildSnapshot(rows: Policy[]): GovernanceSnapshot {';
	const at = src.indexOf(decl);
	if (at === -1) throw new Error('buildSnapshot not found in host/policy-store.ts');
	const body = stripComments(balanced(src, at + decl.length - 1, '{'));
	return new Set([...body.matchAll(/by\.get\(\s*(['"`])([^'"`]+)\1\s*\)/g)].map((x) => x[2]!));
}
const PARSED_KEYS = parsedPolicyKeys();

/** Every backend `.ts` file that READS `.<field>` as a property, per snapshot field. */
function consumersByField(): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const f of SNAPSHOT_FIELDS) out.set(f, []);
	for (const file of listTsFiles(BACKEND_SRC)) {
		if (NOT_A_CONSUMER.includes(file)) continue;
		const text = stripCommentsAndStrings(readFileSync(file, 'utf8'));
		for (const f of SNAPSHOT_FIELDS) {
			if (new RegExp(`\\.${f}\\b`).test(text)) out.get(f)!.push(file.slice(BACKEND.length + 1));
		}
	}
	return out;
}
const CONSUMERS = consumersByField();

/**
 * Source shapes that REFUSE — the thing the `enforced` band's note promises ("the run, brokered
 * call, publish or promotion that breaks it is refused") and the `applied` band's note denies.
 *
 * Read from how this backend actually says no, not from a general notion of failure:
 *   `throw` (every rejection path), `unprocessable(` (the 422 helper in utils/http.ts),
 *   `BrokerRejection` / `EgressBlockedError` / `HttpError` (the named rejection classes), and the
 *   two REFUSALS-BY-RETURN this codebase uses instead of throwing: `blocked:` (the pipeline
 *   promotion gate returns `{ blocked: 'review_required' }`) and `policyKey:` (run-policy returns a
 *   `RunPolicyViolation` rather than raising). Omitting the return-shaped ones would score
 *   `promotion.mandatory_review` and `data.pii_scrubbing` — two rails that plainly refuse — at zero.
 */
const REFUSAL =
	/\bthrow\b|\bunprocessable\s*\(|\bBrokerRejection\b|\bEgressBlockedError\b|\bHttpError\b|\bblocked\s*:|\bpolicyKey\s*:/;

/**
 * The GUARD SPAN around one field read: the enclosing statement, extended into the block it opens.
 *
 * Walk back to the nearest `;` `{` `}` (the start of this statement), then forward until the
 * statement ends — a `;` at zero paren AND zero brace depth, or the `}` that closes the first block
 * this statement opened. So `if (…limits.dailyLlmCap) { throw … }` yields the condition AND the
 * body (refusal FOUND), while `set.rollout_pct = snapshot.stagingCanaryPct;` yields one assignment
 * and stops (refusal NOT found) even though the enclosing route handler throws four times.
 *
 * ⛔ FUNCTION-BODY SCOPE WOULD BE USELESS HERE, which is why this is statement-scoped. Measured: the
 * PATCH handler containing `pipeline.ts:445` also contains the `promotion.mandatory_review` and
 * `promotion.required_reviewers` refusals, and the function containing `budget-service.ts:419` also
 * contains a 409 about tenant credentials. A function-scoped rule scores every one of the rails
 * this branch reclassified as still refusing, i.e. it reproduces the exact defect.
 *
 * The 6000-char cap bounds a pathological span; no real span in `backend/src` comes near it (the
 * longest measured is under 900).
 */
export function guardSpan(text: string, at: number): string {
	let start = 0;
	for (let i = at; i >= 0; i--) {
		const c = text[i];
		if (c === ';' || c === '{' || c === '}') {
			start = i + 1;
			break;
		}
	}
	let paren = 0;
	let brace = 0;
	let opened = false;
	let i = start;
	for (; i < text.length && i - start < 6000; i++) {
		const c = text[i];
		if (c === '(') paren++;
		else if (c === ')') paren--;
		else if (c === '{') {
			brace++;
			opened = true;
		} else if (c === '}') {
			brace--;
			if (opened && brace <= 0) {
				i++;
				break;
			}
			if (brace < 0) break;
		} else if (c === ';' && paren <= 0 && brace <= 0) {
			i++;
			break;
		}
	}
	return text.slice(start, i);
}

/** Per snapshot field: every `file:line` where a read of it sits inside a guard span that refuses. */
function refusalReadsByField(): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const f of SNAPSHOT_FIELDS) out.set(f, []);
	for (const file of listTsFiles(BACKEND_SRC)) {
		if (NOT_A_CONSUMER.includes(file)) continue;
		const text = stripCommentsAndStrings(readFileSync(file, 'utf8'));
		for (const f of SNAPSHOT_FIELDS) {
			for (const m of text.matchAll(new RegExp(`\\.${f}\\b`, 'g'))) {
				if (!REFUSAL.test(guardSpan(text, m.index!))) continue;
				const line = text.slice(0, m.index!).split('\n').length;
				out.get(f)!.push(`${file.slice(BACKEND.length + 1)}:${line}`);
			}
		}
	}
	return out;
}
const REFUSAL_READS = refusalReadsByField();

/**
 * ENFORCED rails whose refusal `refusalReads()` provably CANNOT see, each with the measured reason.
 *
 * ⛔ THIS IS THE HONEST BOUNDARY OF THE SCANNER, WRITTEN DOWN. A zero from `refusalReads()` means
 * "no refusal appears in the guard span of any read of this field" — NOT "this rail refuses
 * nothing". Rails have failed it in two distinct ways (the state-mediated one has no live entry
 * since 2026-10-15, but the shape is still possible):
 *
 *   ALIASED READ — the field is read into a local, and the refusal fires on the LOCAL, one or two
 *   statements later, outside the span. Following one level of alias would find these, and would
 *   also start following `const model = snapshot.workTierModels[tier]` into every later use of the
 *   very common identifier `model` — a false-positive surface bigger than the hole it closes.
 *
 *   STATE-MEDIATED REFUSAL — the read changes persisted state and something else refuses on that
 *   state later, in another file, on another request. Nothing lexical can join those.
 *
 * The scanner is therefore used as a VETO ON `'applied'` and never as a licence for `'enforced'`:
 * a false positive only reddens this file (loud), while treating a zero as proof of no-refusal
 * would file a real boundary under a band that says nothing is refused (quiet).
 */
const REFUSAL_SCAN_BLIND_SPOTS: Record<string, string> = {
	// llm-broker.ts:797 `const allowlist = limits.allowlistedModels;` — the BrokerRejection on the
	// next line fires on `allowlist`, not on the field.
	'models.allowlist': 'aliased read; the BrokerRejection fires on the local alias one line later',
	// (`spend.auto_suspend_idle` was the state-mediated entry here until 2026-10-15. An explicit run
	// now resumes an idle suspension instead of refusing, so it is 'applied' and needs no entry.)
	// ⛔ LOAD-BEARING. `blocks/source-gate.ts` gates every block write path and both draft-execute
	// paths, and reads `allowed = (await getSnapshot()).codeExecOutsideBlocks === true;` inside a
	// try/catch, then `return refuse(findings)` TWO STATEMENTS LATER, on the ALIAS — outside the
	// guard span. So the rail is genuinely `enforced` and the scanner genuinely reports zero: the
	// exact pair this registry exists to reconcile. MEASURED, not assumed: deleting these two lines
	// reds the derived test above naming this rail.
	'models.code_exec_outside_blocks':
		'aliased read; the source gate refuses on the local `allowed` two statements after the read'
};

/** The schedulers `server.ts` actually starts at boot. */
function bootedSchedulers(): string[] {
	const src = stripCommentsAndStrings(readFileSync(SERVER, 'utf8'));
	return [...src.matchAll(/\bstart([A-Za-z]+)Scheduler\(\)/g)].map((x) => x[1]!).sort();
}

// ---------------------------------------------------------------- the lexicon

/**
 * Words that CLAIM AN ENFORCEMENT — English and Dutch.
 *
 * ⚠️ A CLAIM IS NOT ONLY A VERB. "When off, only published building blocks may run" names no verb
 * and is still a promise that the SWITCH changes what runs — precisely the sentence
 * `models.code_exec_outside_blocks` shipped while nothing read its field. `when off` /
 * `staat dit uit` are therefore in the lexicon beside `refused` / `geweigerd`.
 *
 * Matched on non-letter boundaries over the lower-cased text, so `blocked` matches and "building
 * block" does not.
 */
const ENFORCEMENT_CLAIMS_EN = [
	'refuse',
	'refuses',
	'refused',
	'refusal',
	'reject',
	'rejects',
	'rejected',
	// ⛔ `block` / `blocks` ARE DELIBERATELY ABSENT and `blocked` is not. "Building block" is this
	// product's core noun — every honest description of `models.code_exec_outside_blocks` contains
	// the bare word — so the singular and plural are pure false positives here (measured: they
	// flagged the corrected sentence "A flow run executes published building blocks only"). The past
	// participle has no such collision: nothing in this domain is "a blocked" anything except a
	// refusal. Do not "fix" this by loosening the boundary regex; the boundary is right, the word is
	// what is ambiguous.
	'blocked',
	'ban',
	'bans',
	'banned',
	'deny',
	'denies',
	'denied',
	'prevent',
	'prevents',
	'prevented',
	'enforce',
	'enforces',
	'enforced',
	'when off'
];
const ENFORCEMENT_CLAIMS_NL = [
	'weiger',
	'weigert',
	'geweigerd',
	'weigering',
	'blokkeer',
	'blokkeert',
	'geblokkeerd',
	'blokkeren',
	'afgedwongen',
	'dwingt af',
	'verboden',
	'verhindert',
	'voorkomt',
	'afgewezen',
	'wijst af',
	'staat dit uit'
];
/** A scheduled-job mechanism. `data.block_prod_data` claimed one — "prepared by the nightly job" —
 *  in all eight locales, and no such job has ever existed. */
const SCHEDULED_JOB_CLAIMS = ['nightly', 'nachtelijk', 'nachtelijke'];

function claims(text: string, lexicon: string[]): string[] {
	const hay = text.toLowerCase();
	return lexicon.filter((w) => new RegExp(`(^|[^\\p{L}])${w}($|[^\\p{L}])`, 'u').test(hay));
}

/** The catalog key for a policy's description: `data.eu_only` → `policy_desc_data_eu_only`. */
const descKey = (policyKey: string) => `policy_desc_${policyKey.replace(/\./g, '_')}`;

// ---------------------------------------------------------------- the contract

describe('a rail may not claim an enforcement it does not have', () => {
	it('every parser found something (guards the parsers themselves)', () => {
		// Without this, a broken path empties every set below and all the comparisons pass vacuously.
		expect(seedKeys.length).toBeGreaterThanOrEqual(16);
		expect(backendPolicyKeys.length).toBeGreaterThanOrEqual(18);
		expect(new Set(backendPolicyKeys).size).toBe(backendPolicyKeys.length);
		expect(CLASSIFIED.size).toBeGreaterThanOrEqual(18);
		expect(SNAPSHOT_FIELDS.size).toBeGreaterThanOrEqual(17);
		expect(PARSED_KEYS.size).toBeGreaterThanOrEqual(17);
		expect(seedDescriptionByKey.size).toBe(seedKeys.length);
		// The four rails at the centre of this defect really are in the sets being compared.
		for (const k of [
			'data.block_prod_data',
			'data.cross_sandbox_isolation',
			'data.eu_only',
			'models.code_exec_outside_blocks'
		]) {
			expect(backendPolicyKeys).toContain(k);
			expect(CLASSIFIED.has(k)).toBe(true);
		}
	});

	it('⛔ the scanner ignores comments and string literals (it measurably must)', () => {
		// ⛔ THE SCANNER'S OWN NON-VACUITY, ON SYNTHETIC SOURCE. `run-policy.ts`'s header names all
		// four unenforced fields in prose and `policy-enforcement.ts` names them in string literals.
		// A scanner that reads either reports a consumer for every one of them and this whole file
		// goes green on the exact defect it exists to catch. Driving the stripper over a fixture is
		// the only way to test a stripper without waiting for the bug.
		const FIXTURE = [
			'// data.eu_only — the snapshot.euOnly field is asserted here in a comment.',
			'/* multi-line: snapshot.blockProdData is discussed but never read. */',
			"const label = 'snapshot.crossSandboxIsolation';",
			'const tpl = `see snapshot.codeExecOutsideBlocks for details`;',
			'const real = snapshot.piiScrubbing;'
		].join('\n');
		const stripped = stripCommentsAndStrings(FIXTURE);
		expect(stripped).toContain('.piiScrubbing');
		expect(stripped).not.toContain('.euOnly');
		expect(stripped).not.toContain('.blockProdData');
		expect(stripped).not.toContain('.crossSandboxIsolation');
		expect(stripped).not.toContain('.codeExecOutsideBlocks');
		// Line numbers survive, so a failure can name file:line.
		expect(stripped.split('\n').length).toBe(FIXTURE.split('\n').length);
		// …and the REAL scan still finds the enforced fields through the same stripper, so the fix
		// did not buy the fixture at the cost of the thing it guards.
		expect(CONSUMERS.get('externalHttp')!.length).toBeGreaterThan(0);
		expect(CONSUMERS.get('piiScrubbing')!.length).toBeGreaterThan(0);
	});

	it('⛔ the refusal scan distinguishes a GUARD from an ASSIGNMENT (on synthetic source)', () => {
		// ⛔ THE SCANNER'S OWN NON-VACUITY, and this one matters more than the stripper's. A detector
		// that never fires makes "no refusal beside this read" vacuously true for every rail, and the
		// `'applied'` classification becomes unfalsifiable. A detector that always fires makes
		// `'applied'` unreachable. Both halves are driven over a fixture shaped like the two real
		// sites this branch turns on.
		const FIXTURE = [
			'function handler() {', //                                            0
			'  if (limits.dailyLlmCap < n) {', //                                 1  GUARD → refuses
			'    throw new BrokerRejection();', //                                2
			'  }', //                                                             3
			'  set.rollout_pct = snapshot.stagingCanaryPct;', //                   4  ASSIGN → does not
			'  if (gated) { return { blocked: 1 }; }', //                          5
			'  const model = snapshot.workTierModels[tier];', //                   6  ASSIGN → does not
			'  throw new HttpError(500);', //                                      7
			'}'
		].join('\n');
		const at = (needle: string) => FIXTURE.indexOf(needle);
		// The guarded read sees its own throw…
		expect(REFUSAL.test(guardSpan(FIXTURE, at('.dailyLlmCap')))).toBe(true);
		// …and the two assignments do NOT, even though this function throws twice and returns a
		// `{ blocked: … }` in between. THIS is the case a function-scoped rule gets wrong, and
		// getting it wrong reclassifies both rails back to 'enforced' — the defect, restored.
		expect(REFUSAL.test(guardSpan(FIXTURE, at('.stagingCanaryPct')))).toBe(false);
		expect(REFUSAL.test(guardSpan(FIXTURE, at('.workTierModels')))).toBe(false);
		// A refusal-by-RETURN counts too — this codebase refuses that way in run-policy and pipeline.
		expect(REFUSAL.test('if (gated) { return { blocked: 1 }; }')).toBe(true);
		expect(REFUSAL.test('return { policyKey: 1 };')).toBe(true);
		// …and the span really is bounded, not "the rest of the file".
		expect(guardSpan(FIXTURE, at('.stagingCanaryPct'))).not.toContain('throw');
		expect(guardSpan(FIXTURE, at('.stagingCanaryPct')).trim()).toBe(
			'set.rollout_pct = snapshot.stagingCanaryPct;'
		);
	});

	it('⛔ the refusal scan FIRES on the rails that really refuse, in the real backend', () => {
		// The other half of non-vacuity, on real source rather than a fixture: nine of the fourteen
		// enforced rails are detected, each at the line that actually says no. If a refusal is ever
		// deleted from one of these, this reddens HERE — which is a strengthening the old
		// consumer-only rule could not express, because deleting the throw leaves the read behind.
		const detected: Record<string, string> = {
			dailyLlmCap: 'src/host/llm-broker.ts',
			weeklySpendUsd: 'src/host/llm-broker.ts',
			externalHttp: 'src/host/egress-guard.ts',
			egressAllowlist: 'src/host/egress-guard.ts',
			piiScrubbing: 'src/host/run-policy.ts',
			dataValidation: 'src/host/run-controller.ts',
			mandatoryReview: 'src/routes/pipeline.ts',
			requiredReviewers: 'src/routes/pipeline.ts',
			requirePassingTests: 'src/blocks/authoring-service.ts'
		};
		for (const [field, file] of Object.entries(detected)) {
			const hits = REFUSAL_READS.get(field);
			expect(`${field}: ${JSON.stringify(hits)}`).toContain(file);
			expect(hits!.length).toBeGreaterThan(0);
		}
		// …and it does NOT fire on rails nothing reads at all, which would mean the regex is matching
		// the file rather than the span.
		//
		// ⚠️ `codeExecOutsideBlocks` IS DELIBERATELY NOT IN THIS LIST. It used to belong here, and
		// `blocks/source-gate.ts` took it out: that rail now has a real gate, so it is no longer "a
		// rail nothing reads". Left in place the assertion would have kept PASSING while its own
		// stated reason went false — the failure mode this whole file exists to catch. Its home is
		// `REFUSAL_SCAN_BLIND_SPOTS`, because the gate refuses on an alias the span cannot see.
		for (const f of ['blockProdData', 'crossSandboxIsolation']) {
			expect(REFUSAL_READS.get(f)).toEqual([]);
		}
	});

	it('⚠️ every ENFORCED rail is either SEEN refusing, or a NAMED blind spot with a reason', () => {
		// ⛔ THIS TEST EXISTS SO THAT "0 REFUSALS" IS NEVER READ AS "REFUSES NOTHING". The scanner is
		// a near-miss detector, and rails that genuinely refuse can score zero for reasons no lexical
		// scan can fix. Hand-listing the misses on both sides would go stale the moment a rail is
		// added, so the statement is DERIVED: every rail classified `enforced` must either be seen
		// refusing, or appear in `REFUSAL_SCAN_BLIND_SPOTS` with a written reason. A new enforced
		// rail the scanner cannot see reddens here and forces a human to say why — it can never
		// slip through as an unexplained zero.
		//
		// ⚠️ IF A RAIL LEAVES THIS LIST BECAUSE THE SCANNER STARTED SEEING IT, THE SCANNER GOT
		// BETTER, NOT WORSE. Move it into the `detected` map above and delete its entry — do not
		// relax anything.
		const enforced = [...CLASSIFIED].filter(([, e]) => e.enforcement === 'enforced');
		const unseen = enforced.filter(([, e]) => (REFUSAL_READS.get(e.field!) ?? []).length === 0);
		const unexplained = unseen.map(([k]) => k).filter((k) => !(k in REFUSAL_SCAN_BLIND_SPOTS));
		expect(unexplained).toEqual([]);

		// Non-vacuity, both directions.
		// (1) The set being filtered is real and MOST of it IS seen — otherwise "no unexplained
		//     misses" would be satisfied by a scanner that sees everything, or by an empty map.
		//     MEASURED against the classification, not arithmetic in my head: 18 rails = 11 enforced
		//     + 3 applied + 3 architectural + 1 retired, and 9 of the 11 enforced are SEEN refusing.
		//     Floors, not exact counts, so that a rail moving between kinds does not force an edit
		//     here. They have already absorbed one such move: `models.code_exec_outside_blocks`
		//     gained a real gate and went architectural → enforced, taking the tree to 12 enforced
		//     with 3 unseen and 9 still seen. Both floors held without being touched. A second move
		//     (2026-10-15): `spend.auto_suspend_idle` enforced → applied, back to 11 enforced, 2
		//     unseen, 9 seen.
		expect(enforced.length).toBeGreaterThanOrEqual(11);
		expect(enforced.length - unseen.length).toBeGreaterThanOrEqual(9);
		// (2) The blind spots that are LIVE on this branch really are blind and really are
		//     enforced — so the registry is carrying weight, not decorating an empty set.
		for (const k of ['models.allowlist', 'models.code_exec_outside_blocks']) {
			expect(unseen.map(([key]) => key)).toContain(k);
			expect(CLASSIFIED.get(k)!.enforcement).toBe('enforced');
			// …and both DO have consumers: the reason they stay `enforced` is the consumer rule,
			// exactly as before this branch — not an empty set carrying them.
			expect(CONSUMERS.get(CLASSIFIED.get(k)!.field!)!.length).toBeGreaterThan(0);
		}
		// (3) Every reason is actually written. An entry with an empty string would silence the
		//     guard while explaining nothing.
		for (const [k, why] of Object.entries(REFUSAL_SCAN_BLIND_SPOTS)) {
			expect(`${k}: ${why}`.length).toBeGreaterThan(40);
		}
	});

	it('every policy the backend ships is classified, and nothing else is', () => {
		// The two migration-only rails (`models.work_tiers`, `models.pricing`) are exactly the pair a
		// hand-copied list drops, which is why both sides are read from source.
		expect([...backendPolicyKeys].sort()).toEqual([...CLASSIFIED.keys()].sort());
		for (const [, e] of CLASSIFIED) {
			expect(['enforced', 'applied', 'architectural', 'retired']).toContain(e.enforcement);
		}
	});

	it('every classified field is a real GovernanceSnapshot field', () => {
		const bogus = [...CLASSIFIED]
			.filter(([, e]) => e.field !== null && !SNAPSHOT_FIELDS.has(e.field))
			.map(([k, e]) => `${k} → ${e.field}`);
		expect(bogus).toEqual([]);
	});

	it('⛔ ENFORCED needs a consumer; ARCHITECTURAL may have none; APPLIED needs a consumer and NO refusal', () => {
		// THE ASSERTION, in the shape the fourth kind forced.
		//
		// ⛔ IT USED TO BE A BOOLEAN — `enforced` iff the field has a consumer — and that is exactly
		// the gap `'applied'` exists to close. THREE rails had a consumer and refused nothing:
		// `promotion.staging_canary_pct` (`pipeline.ts:445` ASSIGNS `rollout_pct`, never compared to
		// anything anywhere), `models.work_tiers` (`budget-service.ts:419` PICKS a model) and
		// `models.pricing` (`llm-broker.ts:324` PRICES a finished call). Under the old rule they were
		// forced into `'enforced'` — the band whose note promises, in eight languages, that something
		// that breaks the rail is refused and that the refusal names it. HAVING A CONSUMER IS NOT
		// REFUSING. The rule is now per kind:
		//
		//   enforced      consumers > 0                    (UNCHANGED — see the note below)
		//   applied       consumers > 0 AND refusals == 0
		//   architectural consumers == 0
		//   retired       field === null (the RETIRED test owns this one)
		//
		// ⚠️ THE `enforced` SIDE IS DELIBERATELY NOT TIGHTENED TO `refusals > 0`. Two rails that
		// genuinely refuse score zero on the scanner for reasons no lexical scan can fix — an
		// aliased read (`models.allowlist`) and a state-mediated refusal (`spend.auto_suspend_idle`);
		// both are pinned by name in the scanner test below. Making `refusals > 0` a REQUIREMENT of
		// `enforced` would red those two and the only way out would be to demote a real boundary.
		// So the scanner is used as a VETO on `applied`, never as a licence for `enforced`.
		const wrong: string[] = [];
		for (const [key, e] of CLASSIFIED) {
			const consumers = e.field ? CONSUMERS.get(e.field)! : [];
			const refusals = e.field ? REFUSAL_READS.get(e.field)! : [];
			if (e.enforcement === 'enforced' && consumers.length === 0) {
				wrong.push(`${key} claims 'enforced' but nothing reads .${e.field}`);
			}
			if (e.enforcement === 'applied') {
				if (consumers.length === 0) {
					wrong.push(
						`${key} claims 'applied' but nothing reads .${e.field} — 'applied' promises the ` +
							`edit changes the next run or call; with no consumer at all it is 'architectural'`
					);
				}
				if (refusals.length > 0) {
					wrong.push(
						`${key} is 'applied' but .${e.field} is read inside a refusal at ${refusals.join(', ')} — ` +
							`the 'applied' band's note says nothing is refused, so this is 'enforced'`
					);
				}
			}
			if (
				(e.enforcement === 'architectural' || e.enforcement === 'retired') &&
				consumers.length > 0
			) {
				wrong.push(
					`${key} is '${e.enforcement}' but .${e.field} is read by ${consumers.join(', ')} — ` +
						`reclassify it as 'enforced' or 'applied' (and revisit its description)`
				);
			}
		}
		expect(wrong).toEqual([]);
		// ⛔ THE THREE RAILS THIS KIND WAS INVENTED FOR, pinned by name. Without these, the loop above
		// is satisfied by a map with no 'applied' entries at all — i.e. by reverting the change.
		// (`models.work_tiers` left this list in 0099: its only consumer, the welcome budget, is retired.)
		for (const k of ['promotion.staging_canary_pct', 'models.pricing']) {
			expect(CLASSIFIED.get(k)!.enforcement).toBe('applied');
			expect(CONSUMERS.get(CLASSIFIED.get(k)!.field!)!.length).toBeGreaterThan(0);
			expect(REFUSAL_READS.get(CLASSIFIED.get(k)!.field!)!).toEqual([]);
		}
		// Non-vacuity: the surviving unenforced rails are what this is about, and their fields really
		// do have an empty consumer set.
		//
		// ⛔ THIS LIST SHRANK BY ONE AT INTEGRATION, AND THAT IS THE GUARD WORKING, NOT DRIFT.
		// `models.code_exec_outside_blocks` was correctly `architectural` when this test was written —
		// nothing read `codeExecOutsideBlocks`. A sibling lane then added `blocks/source-gate.ts`,
		// which reads it to decide whether a source that trips the static scan is refused, so the rail
		// acquired a real consumer and the assertion above reddened with the exact remedy. It is now
		// `enforced` and covered by the general check; keeping it here would have asserted the
		// opposite of what the code does. If a rail ever LOSES its last consumer, expect the reverse
		// failure and move it back — do not delete the anchor, or this whole test can pass vacuously.
		for (const k of ['data.block_prod_data', 'data.cross_sandbox_isolation', 'models.work_tiers']) {
			expect(CLASSIFIED.get(k)!.enforcement).toBe('architectural');
			expect(CONSUMERS.get(CLASSIFIED.get(k)!.field!)!).toEqual([]);
		}
	});

	it('⛔ RETIRED iff buildSnapshot does not parse the row at all', () => {
		// The machine-checkable definition of retirement. `data.eu_only` promised EU residency that
		// nothing ever checked; withdrawing the claim means the runtime stops carrying it, not just
		// that the words changed. If a future edit puts `by.get('data.eu_only')` back, this reddens.
		const wrong: string[] = [];
		for (const [key, e] of CLASSIFIED) {
			const parsed = PARSED_KEYS.has(key);
			if (e.enforcement === 'retired' && (parsed || e.field !== null)) {
				wrong.push(`${key} is 'retired' but is still parsed into the snapshot`);
			}
			if (e.enforcement !== 'retired' && (!parsed || e.field === null)) {
				wrong.push(`${key} is '${e.enforcement}' but buildSnapshot never reads it`);
			}
		}
		expect(wrong).toEqual([]);
		expect(CLASSIFIED.get('data.eu_only')!.enforcement).toBe('retired');
		expect(PARSED_KEYS.has('data.eu_only')).toBe(false);
		// …and the row itself must still be SEEDED: `policy_changes.policy_key` is an FK onto
		// `policies.key` with ON DELETE CASCADE, so dropping the row would delete recorded history.
		expect(seedKeys).toContain('data.eu_only');
	});

	it('⛔ a description that CLAIMS an enforcement belongs to an ENFORCED rail (en + nl + seeder)', () => {
		// THE COPY HALF. `policy_desc_models_code_exec_outside_blocks` read "arbitrary code/eval is
		// banned at save time and refused at run time" in English and "…wordt bij opslaan geweigerd
		// en bij uitvoeren geblokkeerd" in Dutch, on a rail no code reads. Reverting either string
		// reddens this.
		const offenders: string[] = [];
		for (const [key, e] of CLASSIFIED) {
			if (e.enforcement === 'enforced') continue;
			const sources: [string, string, string[]][] = [
				['en', enCatalog[descKey(key)] ?? '', ENFORCEMENT_CLAIMS_EN],
				['nl', nlCatalog[descKey(key)] ?? '', ENFORCEMENT_CLAIMS_NL],
				['seed', seedDescriptionByKey.get(key) ?? '', ENFORCEMENT_CLAIMS_EN]
			];
			for (const [where, text, lexicon] of sources) {
				const hits = claims(text, lexicon);
				if (hits.length) offenders.push(`${key} [${where}] claims ${hits.join('/')}`);
			}
		}
		expect(offenders).toEqual([]);

		// Non-vacuity, both directions. The lexicon must actually fire on the strings that DO make
		// the claim — otherwise "no offenders" only means "the lexicon matches nothing".
		expect(claims(enCatalog.policy_desc_models_allowlist!, ENFORCEMENT_CLAIMS_EN)).toContain(
			'refuses'
		);
		expect(claims(nlCatalog.policy_desc_models_allowlist!, ENFORCEMENT_CLAIMS_NL)).toContain(
			'weigert'
		);
		expect(
			claims(
				'When off, only published building blocks may run — arbitrary code/eval is banned at save time and refused at run time.',
				ENFORCEMENT_CLAIMS_EN
			).sort()
		).toEqual(['banned', 'refused', 'when off']);
		expect(
			claims(
				'Staat dit uit, dan mogen alleen gepubliceerde bouwblokken draaien — willekeurige code of eval wordt bij opslaan geweigerd en bij uitvoeren geblokkeerd.',
				ENFORCEMENT_CLAIMS_NL
			).sort()
		).toEqual(['geblokkeerd', 'geweigerd', 'staat dit uit']);
		// …and it does NOT fire on this product's core noun, in either number — see the lexicon note.
		expect(claims('a published building block', ENFORCEMENT_CLAIMS_EN)).toEqual([]);
		expect(
			claims('A flow run executes published building blocks only.', ENFORCEMENT_CLAIMS_EN)
		).toEqual([]);
	});

	it('⛔ no rail credits a scheduled job — there is no nightly mock-data job', () => {
		// `policy_desc_data_block_prod_data` said sandboxes get "synthesized mock data prepared by
		// THE NIGHTLY JOB", in all eight locales. Exactly three schedulers boot (the welcome-budget
		// poller was retired in 0099), none of them touches
		// mock data, and `ctx.mockData()` is a deterministic hash resolved inside the runner
		// (backend/src/exec/mock-data.ts). The scheduler set is READ FROM server.ts rather than
		// remembered, so adding a fifth is a decision someone has to come here and defend.
		expect(bootedSchedulers()).toEqual(['AuditExport', 'Cycle', 'Translation']);
		const offenders: string[] = [];
		for (const key of CLASSIFIED.keys()) {
			for (const [where, text] of [
				['en', enCatalog[descKey(key)] ?? ''],
				['nl', nlCatalog[descKey(key)] ?? ''],
				['seed', seedDescriptionByKey.get(key) ?? '']
			] as [string, string][]) {
				const hits = claims(text, SCHEDULED_JOB_CLAIMS);
				if (hits.length) offenders.push(`${key} [${where}] credits ${hits.join('/')}`);
			}
		}
		expect(offenders).toEqual([]);
		// Non-vacuity: the lexicon fires on the sentence that shipped.
		expect(
			claims(
				'All sandboxes receive synthesized mock data prepared by the nightly job.',
				SCHEDULED_JOB_CLAIMS
			)
		).toEqual(['nightly']);
	});

	it('⛔ a RETIRED claim is not re-made somewhere else in the product — /docs, all eight locales', () => {
		// ⛔ THE SECOND PLACE THE EU CLAIM LIVED. Retiring `data.eu_only` on /governance is worth
		// nothing if `docs_samplepolicy_p2` still tells every builder that "which models are allowed,
		// whether external network calls are permitted, EU-ONLY PROCESSING … are enforced at run time
		// for everyone. If a run is blocked, the reason points at the exact policy." The other two
		// clauses are true; the residency one was not, and `enforceRunPolicies` can only ever return
		// `models.external_http` or `data.pii_scrubbing`, so no refusal could ever have pointed at it.
		//
		// ⚠️ CHECKED IN ALL EIGHT LOCALES, not just en/nl, because this is a REGULATORY claim and a
		// clause left behind in one translation is still a claim the product makes. That is affordable
		// here — unlike the enforcement lexicon above — because the tokens are proper nouns for one
		// entity rather than a verb vocabulary: an eight-language list of ways to write "the European
		// Union" is something this file can state honestly.
		const EU_TOKENS: Record<string, string[]> = {
			en: ['EU', 'European Union'],
			nl: ['EU', 'Europese Unie'],
			de: ['EU', 'Europäischen Union'],
			fr: ['UE', 'Union européenne'],
			es: ['UE', 'Unión Europea'],
			pl: ['UE', 'Unii Europejskiej'],
			ar: ['الأوروبي'],
			// ⚠️ THE ADJECTIVE, NOT THE FULL NAME. The Hebrew clause that shipped read "עיבוד באיחוד
			// האירופי בלבד" — the noun is INFLECTED with a prefixed ב, so a token of "האיחוד האירופי"
			// does not match the very sentence this guard exists to keep out. Same reasoning for the
			// Arabic token. Verified against the shipped strings in the non-vacuity block below.
			he: ['האירופי']
		};
		const catalogs: Record<string, Record<string, string>> = {};
		for (const loc of Object.keys(EU_TOKENS)) {
			catalogs[loc] = JSON.parse(
				readFileSync(fileURLToPath(new URL(`../../../messages/${loc}.json`, import.meta.url)), 'utf8')
			) as Record<string, string>;
		}
		const hits = (text: string, tokens: string[]) =>
			tokens.filter((t) =>
				/^[A-Za-z ]+$/.test(t)
					? new RegExp(`(^|[^\\p{L}])${t}($|[^\\p{L}])`, 'u').test(text)
					: text.includes(t)
			);
		const offenders: string[] = [];
		for (const [loc, tokens] of Object.entries(EU_TOKENS)) {
			const text = catalogs[loc]!.docs_samplepolicy_p2;
			expect(text, `${loc}: docs_samplepolicy_p2 missing`).toBeTruthy();
			const found = hits(text!, tokens);
			if (found.length) offenders.push(`${loc} still claims ${found.join('/')}`);
		}
		expect(offenders).toEqual([]);
		// Non-vacuity: the token lists really do fire on the sentences that shipped. Without this,
		// eight typo'd token lists would read as eight clean locales.
		expect(
			hits(
				'…whether external network calls are permitted, EU-only processing — are enforced at run time.',
				EU_TOKENS.en!
			)
		).toEqual(['EU']);
		expect(
			hits('…of externe netwerkaanroepen mogen, verwerking uitsluitend in de EU —', EU_TOKENS.nl!)
		).toEqual(['EU']);
		expect(
			hits('…وهل تُسمح الاتصالات الشبكية الخارجية، والمعالجة داخل الاتحاد الأوروبي فقط —', EU_TOKENS.ar!)
		).toEqual(['الأوروبي']);
		expect(
			hits('…האם מותרות קריאות רשת חיצוניות, עיבוד באיחוד האירופי בלבד —', EU_TOKENS.he!)
		).toEqual(['האירופי']);
		for (const [loc, clause] of [
			['de', 'ob externe Netzwerkaufrufe zulässig sind, Verarbeitung nur in der EU – werden'],
			['fr', 'si les appels réseau externes sont permis, traitement exclusivement dans l’UE —'],
			['es', 'si se admiten llamadas de red externas, procesamiento solo en la UE—'],
			['pl', 'czy wolno wykonywać zewnętrzne połączenia sieciowe, przetwarzanie wyłącznie w UE —']
		] as [string, string][]) {
			expect(hits(clause, EU_TOKENS[loc]!), loc).not.toEqual([]);
		}
		// And the rail itself is genuinely retired, so this assertion is about a withdrawn claim and
		// not about a rail that quietly still works.
		expect(CLASSIFIED.get('data.eu_only')!.enforcement).toBe('retired');
	});

	it('every classified rail has words in BOTH checked catalogs', () => {
		// The lexicon assertions are only meaningful if the strings they read exist. A missing key
		// would make `?? ''` silently pass every check above.
		const missing: string[] = [];
		for (const key of CLASSIFIED.keys()) {
			if (!(descKey(key) in enCatalog)) missing.push(`en:${descKey(key)}`);
			if (!(descKey(key) in nlCatalog)) missing.push(`nl:${descKey(key)}`);
		}
		expect(missing).toEqual([]);
	});
});
