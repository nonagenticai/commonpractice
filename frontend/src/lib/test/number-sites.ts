// src/lib/test/number-sites.ts — DISCOVER every place this app puts a number in front of a reader,
// so that the inventory in `$lib/i18n/icu-number-params.sites.test.ts` can be asserted COMPLETE
// instead of merely being long.
//
// ⛔ WHY THIS MODULE EXISTS, AND IT IS THE ROOT CAUSE OF BOTH DEFECTS #256 LEFT BEHIND. That file's
// `GROUPED` array is eighteen entries a human typed out. Every entry is checked; the ARRAY is not.
// Nothing anywhere asserted that eighteen was all of them, so two whole classes stayed invisible:
//
//   · `routes/challenges/+page.svelte:218` renders `<span class="chip-count">{countFor(d.v)}</span>`
//     — "11774" — while :272 of the SAME FILE, a line #256 itself edited, renders "11.774" through
//     `num()`. One screen, two spellings of the same figure, in the file the fix was working in.
//   · `lib/components/build/ChallengeDataPanel.svelte:101` renders `{it.rowCount}` raw while
//     `routes/connectors/+page.svelte:433` renders the SAME FIELD through `num()`.
//
// A hand-written list cannot see either one, because a list only knows what is in it. So the list
// is now checked against a SCAN: every site this module discovers must be classified — grouped, or
// excluded with a stated reason — and an unclassified site is a test failure that names the file,
// the line and the expression.
//
// ⚠️ THE SCAN'S OWN COVERAGE IS THE NEXT PLACE THIS CAN ROT, so it is derived rather than guessed.
// `isNumeric()` does not pattern-match hopeful names like /count|total/ — that heuristic misses
// `activeRuns`, `llmCalls` and `p95LatencyMs`, which is exactly how the first list went stale. It
// asks the codebase instead: `numericVocabulary()` collects every identifier DECLARED as a number
// (`foo: number`, `foo?: number | null`, `function foo(): number`, `$state<number>`) across every
// `.ts` and `.svelte` file under `src/`. A new numeric field therefore joins the vocabulary the
// moment it is declared, and the first time it is rendered the guard demands a decision about it.
//
// ⚠️ FALSE POSITIVES ARE THE SAFE DIRECTION AND ARE DELIBERATE. A site that only tests a number
// (`{items.length ? m.a() : m.b()}`) is flagged and must be written down as an exclusion. That is
// noise, and it is the trade: the alternative failure — a real figure that nothing flags — is the
// defect this whole file exists to end.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { stripComments } from './source-scan';

const SRC = resolve(process.cwd(), 'src');

/** Every `.ts` / `.svelte` file under `src/`, excluding generated paraglide output and tests. */
export function sourceFiles(ext: RegExp = /\.(ts|svelte)$/): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir).sort()) {
			const p = join(dir, entry);
			if (statSync(p).isDirectory()) {
				if (entry === 'paraglide' || entry === 'node_modules') continue;
				walk(p);
			} else if (ext.test(entry) && !/\.test\.ts$/.test(entry)) {
				out.push(p);
			}
		}
	};
	walk(SRC);
	return out;
}

/** A path as this repo's test inventories spell it: relative to `src/`, forward slashes. */
export const rel = (abs: string): string => relative(SRC, abs).split(sep).join('/');

/** `x.foo` — a FIELD anywhere in the codebase declared `number`. Global: fields are shared. */
const FIELD_DECL =
	/(?:^|[\s{;,(])(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:\s*(?:number\b(?!\s*\[)|number\s*\|\s*null|null\s*\|\s*number)/g;

/**
 * A bare `foo` — a local, or a helper returning a number. File-scoped: `p` and `r` are not shared.
 *
 * ⚠️ THE LAST PATTERN IS NOT DECORATION — IT IS THE ONE HOLE THIS SCAN WAS MEASURED TO HAVE. Every
 * numeric helper rendered into markup in this app carries an explicit return type except
 * `routes/audit/+page.svelte`'s `const countFor = (key) => feed?.counts?.[…] ?? 0`, which is the
 * audit board's chip count — the same figure, on the same kind of chip, as the `/challenges` one
 * that is the headline of this whole change. An un-annotated arrow was therefore invisible, so a
 * numeric ZERO FALLBACK counts as a declaration too. Verified by enumerating every `{fn(…)}` in
 * text position across all 120 components: `countFor` was the only one.
 */
const LOCAL_DECLS = [
	/function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*:\s*(?:number\s*\|\s*null|number)\b/g,
	/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*\([^)]*\)\s*:\s*(?:number\s*\|\s*null|number)\b/g,
	/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::\s*(?:number\s*\|\s*null|number)\b|=\s*\$(?:state|derived)<\s*number\b)/g,
	/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*\([^)]*\)\s*=>[^;\n]*\?\?\s*-?\d/g
];

/**
 * ⛔ THE SECOND MEASURED HOLE: `const max = $derived(<numeric expression>)`, NO TYPE ANNOTATION.
 *
 * Every pattern above needs the word `number` written down somewhere — an annotation, a return type,
 * or the explicit `$derived<number>` form. A bare `$derived(…)` writes none of them; it is the way
 * Svelte 5 idiom *prefers*, because the rune infers. So the whole shape was invisible: the scan
 * could not see the local, the local therefore never reached a render site, and the site was never
 * classified. This was known and written off as a single instance (`block-edit/+page.svelte`'s
 * `lineCount`, whose plural site is pinned by hand in `PLURAL_SITES`). It was not a single instance.
 * Measured across the tree: 136 bare `$derived(…)` bindings, of which 35 are judged numeric, and two
 * of them — `ops/Sparkline.svelte:max` and `block-edit/BlockUsageTrend.svelte:max` — were printed RAW
 * into an axis label THIRTEEN LINES ABOVE a `num()`-grouped tooltip of the same figures. On /it-dash
 * a 4-digit peak read "1207" on the axis and "1.207" in the tooltip that explains the axis.
 *
 * ⚠️ SOME OF THE 35 ARE NOT NUMBERS, and that is the documented trade at the top of this file rather
 * than an oversight: `KanbanCard:selfNoteId` is a template literal whose `${card.id}` leaks past the
 * string-blanking regex, `PipelineStats:anyLive` and `it-dash:p95Warn` are booleans left behind by a
 * comparison this module's reducer does not fully strip, and `challenges/[id]:id` is a route param
 * that collides with a numeric `id` field. None is rendered bare, so none reaches the inventory; the
 * day one is, it gets a line in `RAW_RENDER` saying why. A false positive costs a sentence. The
 * other direction cost this app two spellings of the same figure on one panel.
 *
 * ⛔ THE BODY IS JUDGED BY `numericIdentifiers()`, NOT BY A LITERAL-SHAPE HEURISTIC, and that is the
 * load-bearing choice. The obvious cheap rule — "numeric if it ends in `?? <digit>`", the trick the
 * last pattern above plays on un-annotated arrows — is defeated by exactly one character:
 * `build/ForeachNode.svelte`'s `const maxIter = $derived(data.loop?.maxIterations ?? null)` renders
 * that count into a badge, and `?? null` sails straight past a `?? \d` catch. Asking the SAME
 * detector that judges every render site answers it correctly for the right reason: the expression
 * reads `maxIterations`, which the codebase declares `: number`. A derived local is a number when
 * the thing it is derived FROM is a number, and that question already has an implementation here.
 *
 * ⚠️ `Math.` IS SPELLED OUT because argument-dropping eats the evidence. `numericIdentifiers()`
 * discards call ARGUMENTS on purpose (`countFor(d.v)` renders the return, not the key), so
 * `Math.min(offset + tenants.length, total)` reduces to the bare chain `Math.min` and the `.length`
 * inside it is gone. `Math.max` happened to survive only by ACCIDENT — `max` is a declared field
 * (`seats.max: number`) elsewhere in the app, so the chain's last link hit the field vocabulary.
 * A guard that works by coincidence is a guard that stops working when someone renames a DTO field.
 *
 * ⛔⛔ WHAT THIS STILL DOES NOT SEE — STATED, BECAUSE A DOCBLOCK THAT IMPLIES FULL COVERAGE IS HOW
 * THE HAND-WRITTEN LIST GOT HERE. Adversarial review of this very change found four residual
 * spellings. They are listed so the next reader extends the scan instead of trusting it:
 *
 *   1. ⚠️ AN IMPORTED NUMERIC CONST — `$derived(EXTERNAL_COUNT)`, or a bare `{EXTERNAL_COUNT}`.
 *      This is a CLASS, not a hypothetical: `stores/builder-graph.ts` exports
 *      `export const HARD_MAX_ITERATIONS = 1000` with no annotation, `NodeConfigPanel.svelte`
 *      renders it, and it is exactly the four-digit figure that needed grouping. It is pinned by
 *      hand in `DIRECT_RENDER` because nothing here can reach across a module boundary. Closing it
 *      properly means resolving imports — a scan of a different shape, not a wider regex.
 *   2. An imported helper with a declared `: number` return. `LOCAL_DECLS` is file-scoped by
 *      design (see the `p`/`r`/`b`/`v` measurement below); a cross-file function table would
 *      reintroduce the flat-set false positives that made an earlier version unreadable.
 *   3. `$derived.by(…)`. Its body is a statement BLOCK, so every intermediate votes on the result:
 *      `BlockUsageTrend.svelte`'s `linePts` builds an SVG points STRING out of `points.length` and
 *      arithmetic, and reading the block as one expression calls that a number. All 14 in the tree
 *      were checked by hand for a raw numeric render site; there are none, and every one returns a
 *      string, an array or an object. The honest fix is to read the block's `return` expressions.
 *   4. A number that reaches the screen without ever being NAMED — `{someCall().total}` where the
 *      call is imported, and anything built inside a `{#snippet}` parameter.
 *
 * The residue is bounded the same way the rest of this file is: by the inventory being an EQUALITY,
 * so anything the scan does see must still be classified, and by these four lines being the list a
 * reviewer checks a new spelling against.
 */
const DERIVED_BINDING = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*\$derived\s*\(/g;

/** A numeric shape that survives no identifier: `Math.…`, `Number(…)`, `parseInt/parseFloat`. */
const NUMERIC_BUILTIN = /\bMath\s*\.|\bNumber\s*\(|\bparse(?:Int|Float)\s*\(/;

/** `name` → the `$derived(` … `)` body, paren-matched: several of these run to five lines. */
function derivedBindings(src: string): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	DERIVED_BINDING.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = DERIVED_BINDING.exec(src)) !== null) {
		const open = src.indexOf('(', m.index + m[0].length - 1);
		let depth = 0;
		for (let i = open; i < src.length; i++) {
			if (src[i] === '(') depth++;
			else if (src[i] === ')' && --depth === 0) {
				out.push([m[1]!, src.slice(open + 1, i)]);
				break;
			}
		}
	}
	return out;
}

function collect(src: string, patterns: RegExp[], into: Set<string>): void {
	for (const re of patterns) {
		re.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(src)) !== null) into.add(m[1]!);
	}
}

export type Vocabulary = { fields: Set<string>; locals: Map<string, Set<string>> };

/**
 * Every identifier the codebase declares as a `number`, split by how it can be REACHED.
 *
 * ⛔ DECLARED, NOT GUESSED. This is the whole reason the scan can claim coverage: `activeRuns`,
 * `p95LatencyMs` and `hitCount` are numbers a name-regex would have to have been told about, and
 * `value`, `countdown` and `memIndicator` are NOT numbers although a name-regex would flag two of
 * the three. The declarations are the only place the answer actually lives.
 *
 * ⚠️ THE SPLIT IS NOT TIDINESS — a flat set was measurably useless. Some file declares a local `p`,
 * `r`, `b`, `v` and `error` as numbers (chart geometry, mostly), and a flat set then flagged
 * `{r.text}`, `{b.slug}` and `{error}` in nine other files: 111 "numeric" render sites, of which
 * roughly a dozen were numbers. A list nobody can read is a list nobody maintains, which is how the
 * hand-written one got here. So a bare name is only numeric in the file that declared it, and a
 * dotted name is judged on its FIELD.
 */
export function numericVocabulary(): Vocabulary {
	const fields = new Set<string>();
	const locals = new Map<string, Set<string>>();
	const bodies = new Map<string, Array<[string, string]>>();
	for (const f of sourceFiles()) {
		const src = readFileSync(f, 'utf8');
		collect(src, [FIELD_DECL], fields);
		// ⛔ A FIELD DECLARED IN THIS FILE IS ALSO A BARE NAME IN THIS FILE. Svelte props arrive as
		// `let { nodeCount }: { nodeCount: number } = $props()` and are then rendered bare — which is
		// how `m.build_block_count({ count: nodeCount })`, one of the ten plural sites, fell out of an
		// earlier version of this scan entirely.
		const own = new Set<string>();
		collect(src, [FIELD_DECL, ...LOCAL_DECLS], own);
		locals.set(rel(f), own);
		// ⚠️ COMMENTS STRIPPED FIRST, for the reason `source-scan.ts` records: the first version of the
		// site guard was defeatable by putting the interesting code in a comment. It also keeps a
		// commented-out `$derived(…)` from adding a name that no longer exists.
		bodies.set(rel(f), derivedBindings(stripComments(src)));
	}
	const vocab = { fields, locals };
	// ⛔ TO A FIXED POINT — FOR ORDER-INDEPENDENCE, NOT BECAUSE TODAY'S TREE NEEDS A SECOND LAP.
	// A derived local is routinely derived from another one (`Sparkline`'s `xPct` reads `n`, itself a
	// bare `$derived(buckets.length)`), and a single pass resolves that only while the file happens
	// to be written top-down — every such chain in this repo currently is. MEASURED, because the
	// first version of this comment asserted a convergence it never checked and picked an example
	// that the detector could not even see at the time: 136 bare bindings, pass 0 adds 35, pass 1
	// adds 0. So the loop's second lap is the PROOF that it converged, not a speculative need; what
	// it buys is that reordering two `const`s can never silently drop a site. Bounded at 8 so a
	// cycle cannot hang the suite.
	for (let pass = 0; pass < 8; pass++) {
		let grew = false;
		for (const [file, found] of bodies) {
			const own = locals.get(file)!;
			for (const [name, body] of found) {
				if (own.has(name)) continue;
				if (!NUMERIC_BUILTIN.test(body) && numericIdentifiers(body, vocab, file).length === 0) continue;
				own.add(name);
				grew = true;
			}
		}
		if (!grew) break;
	}
	return vocab;
}

/** The formatters that put a figure into the reader's locale. `num()` is the one for integers;
 *  `exact()` is the one for a value being echoed back unrounded (see its header in format.ts). */
const FORMATTERS =
	/\b(num|exact|decimal1|decimal2|usd|usdEstimated|usdMaybe|money|ms|gb|duration|demoDuration|timeAgo|hourMinute|dayMonth|fullDate|relative|percent)\s*\(/;

/**
 * `foo(a, b)` → `foo` — a CALL's arguments are not rendered, its return value is.
 *
 * ⛔ A GROUPING PAREN IS NOT AN ARGUMENT LIST, AND CONFLATING THEM BLINDED THE WHOLE DETECTOR.
 * This function used to delete every `(…)` group by regex, whatever stood in front of it, so
 * arithmetic simply vanished the moment anyone reached for precedence:
 *
 *     numericIdentifiers('hovered / n')       → ['hovered','n']   ✅
 *     numericIdentifiers('(hovered) / n')     → ['n']             ❌ one paren, one number lost
 *     numericIdentifiers('(hovered + n) / 2') → []                ❌ both lost
 *
 * That is not a `$derived` problem — `{(a + b) / 2}` written straight into markup was invisible to
 * the render scan too, which is a hole older than this module's own headline defect. The rule is
 * now the real one: a `(` is an argument list only when something CALLABLE sits immediately before
 * it (an identifier, a `]`, or a closing `)` of a previous call). Otherwise its contents are part
 * of the value and survive.
 *
 * ⚠️ `.reduce(` IS DELIBERATELY TREATED AS A GROUP, NOT A CALL. It is the one member of the
 * Array-method family whose RESULT is built out of its callback body rather than out of the
 * receiver, and it is this codebase's idiomatic total — `BlockUsageTrend.svelte`'s
 * `$derived(points.reduce((s, p) => s + p.runs, 0))`. Under the general rule its `p.runs` is an
 * argument and disappears, and the total reads as a non-number. `.map`/`.filter` are NOT included:
 * their result is an array, and the thing rendered is whatever is later taken FROM it.
 */
function dropArgs(expr: string): string {
	let out = expr;
	for (;;) {
		const m = out.match(/\(([^()]*)\)/); // innermost group, left to right
		if (!m || m.index === undefined) return out;
		const before = out.slice(0, m.index).replace(/\s+$/, '');
		const callee = before.match(/[A-Za-z0-9_$]+$/)?.[0];
		const isCall = /[A-Za-z0-9_$\])]$/.test(before) && callee !== 'reduce';
		out = out.slice(0, m.index) + (isCall ? ' ' : ` ${m[1]} `) + out.slice(m.index + m[0].length);
	}
}

/** A member chain, as it appears in an expression: `a`, `a.b`, `a!.b`, `a?.b.c`. */
const CHAIN = '[A-Za-z_$][\\w$]*(?:\\s*[!?]?\\s*\\.\\s*[A-Za-z_$][\\w$]*)*';

/**
 * Remove the parts of an expression that produce a BOOLEAN, not a figure.
 *
 * A comparison and a ternary CONDITION are read by the template, never printed by it. Leaving them
 * in made `{editing.id ? m.a() : m.b()}` and `{v.status === 'draft' ? … }` look like rendered
 * numbers, purely because some other module declares an `id: number` and a `status: number`.
 * `{notifications.unread > 9 ? '9+' : notifications.unread}` survives this and should: its ELSE
 * branch really does print a raw count.
 */
function dropBooleanParts(expr: string): string {
	let e = expr.replace(/=>/g, '  ');
	for (;;) {
		const next = e.replace(new RegExp(`(?:${CHAIN}|\\d+)?\\s*(?:===|!==|==|!=|>=|<=|>|<)\\s*(?:${CHAIN}|\\d+)?`, 'g'), ' ');
		if (next === e) break;
		e = next;
	}
	// Ternary conditions: everything up to a top-level `?` that is neither `??` nor `?.`.
	for (;;) {
		let depth = 0;
		let cut = -1;
		for (let i = 0; i < e.length; i++) {
			const c = e[i]!;
			if ('([{'.includes(c)) depth++;
			else if (')]}'.includes(c)) depth--;
			else if (c === '?' && depth === 0 && e[i + 1] !== '?' && e[i + 1] !== '.' && e[i - 1] !== '?') {
				cut = i;
				break;
			}
		}
		if (cut === -1) break;
		e = e.slice(cut + 1);
	}
	return e;
}

/** Drop a `name(` … `)` call, arguments and all, wherever it appears. */
function dropCalls(expr: string, re: RegExp): string {
	let out = expr;
	for (;;) {
		const m = out.match(re);
		if (!m || m.index === undefined) return out;
		const open = out.indexOf('(', m.index);
		let depth = 0;
		let end = -1;
		for (let i = open; i < out.length; i++) {
			if (out[i] === '(') depth++;
			else if (out[i] === ')' && --depth === 0) {
				end = i;
				break;
			}
		}
		if (end === -1) return out.slice(0, m.index);
		out = out.slice(0, m.index) + ' ' + out.slice(end + 1);
	}
}

/**
 * Is this expression a NUMBER on its way to the screen?
 *
 * The expression is reduced first, because the parts that are not rendered must not vote:
 *   · string literals — `step.state === 'done'` is a comparison to text, not the field `done`
 *   · `[…]` subscripts — `buckets[hovered].llmCalls` renders `llmCalls`; `hovered` is an index
 *   · call ARGUMENTS — `countFor(d.v)` renders `countFor`'s return; `d.v` is a lookup key
 *   · formatter calls, whole — `num(rows, locale.current)` leaves nothing numeric behind, which is
 *     precisely what "already grouped" means. A mixed expression such as
 *     `cond ? num(a, l) : b.rowCount` still reports numeric, and it should: half of it is raw.
 */
export function numericIdentifiers(expr: string, vocab: Vocabulary, file: string): string[] {
	let e = expr
		.replace(/'(?:[^'\\]|\\.)*'/g, ' ')
		.replace(/"(?:[^"\\]|\\.)*"/g, ' ')
		.replace(/`(?:[^`\\$]|\\.)*`/g, ' ');
	e = dropCalls(e, FORMATTERS);
	e = dropCalls(e, /\bm\./); // message calls: `messageParamSites()` owns those
	e = dropBooleanParts(e);
	// Subscripts, innermost first.
	for (;;) {
		const next = e.replace(/\[[^[\]]*\]/g, ' ');
		if (next === e) break;
		e = next;
	}
	e = dropArgs(e);
	const own = vocab.locals.get(file) ?? new Set<string>();
	const hits = new Set<string>();
	// ⛔ THE LAST LINK OF EACH MEMBER CHAIN IS THE VALUE. `r.text` renders `text`, not `r`; treating
	// every identifier in the expression as a candidate is what made `{b.slug}` look like a figure.
	for (const m of e.matchAll(new RegExp(CHAIN, 'g'))) {
		const chain = m[0].replace(/\s/g, '').split(/[!?]?\./);
		const last = chain[chain.length - 1]!;
		if (last === 'length') hits.add('.length');
		else if (chain.length > 1 ? vocab.fields.has(last) : own.has(last)) hits.add(last);
	}
	return [...hits].sort();
}

/** Already run through a locale-aware formatter? */
export const isFormatted = (expr: string): boolean => FORMATTERS.test(expr);

export type Site = { file: string; line: number; expr: string; numeric: string[] };

/** Blank out `<script>` / `<style>` bodies, preserving offsets AND line numbers. */
function markupOnly(src: string): string {
	let out = src;
	for (const tag of ['script', 'style']) {
		const re = new RegExp(`<${tag}[^>]*>`, 'g');
		let m: RegExpExecArray | null;
		while ((m = re.exec(out)) !== null) {
			const start = m.index + m[0].length;
			const end = out.indexOf(`</${tag}>`, start);
			if (end === -1) break;
			out = out.slice(0, start) + out.slice(start, end).replace(/[^\n]/g, ' ') + out.slice(end);
			re.lastIndex = end;
		}
	}
	return out;
}

/**
 * Every `{expr}` in element CONTENT — the DIRECT-RENDER half, which had no guard of any kind.
 *
 * ⚠️ CONTENT, NOT ATTRIBUTES. `disabled={page >= totalPages}` and `style="width:{pct}%"` are not
 * text a reader sees, and sweeping them in would have buried the eight real sites in ninety.
 */
export function textRenderSites(vocab: Vocabulary): Site[] {
	const out: Site[] = [];
	for (const f of sourceFiles(/\.svelte$/)) {
		const src = markupOnly(stripComments(readFileSync(f, 'utf8')));
		let inTag = false;
		for (let i = 0; i < src.length; i++) {
			const c = src[i]!;
			if (c === '<' && /[a-zA-Z/!]/.test(src[i + 1] ?? '')) {
				inTag = true;
				continue;
			}
			if (c === '>' && inTag) {
				inTag = false;
				continue;
			}
			if (c !== '{') continue;
			let depth = 0;
			let j = i;
			for (; j < src.length; j++) {
				if (src[j] === '{') depth++;
				else if (src[j] === '}' && --depth === 0) break;
			}
			if (j >= src.length) break;
			const expr = src.slice(i + 1, j).trim().replace(/\s+/g, ' ');
			i = j;
			if (inTag || /^[#/:@]/.test(expr)) continue; // svelte block syntax, not an expression
			const numeric = numericIdentifiers(expr, vocab, rel(f));
			if (numeric.length) out.push({ file: rel(f), line: src.slice(0, j).split('\n').length, expr, numeric });
		}
	}
	return out;
}

export type ParamSite = Site & { key: string; param: string };

/**
 * Every numeric parameter handed to an ICU message — the half `GROUPED` enumerates by hand.
 *
 * Brace-matched and comment-stripped for the reasons `source-scan.ts` records: the first version of
 * the site guard was defeatable by putting the good call in a comment.
 */
export function messageParamSites(vocab: Vocabulary): ParamSite[] {
	const out: ParamSite[] = [];
	for (const f of sourceFiles()) {
		const src = stripComments(readFileSync(f, 'utf8'));
		for (const m of src.matchAll(/\bm\.([A-Za-z0-9_]+)\(\s*\{/g)) {
			const open = src.indexOf('{', m.index! + m[0].length - 1);
			let depth = 0;
			let end = -1;
			for (let i = open; i < src.length; i++) {
				if (src[i] === '{') depth++;
				else if (src[i] === '}' && --depth === 0) {
					end = i;
					break;
				}
			}
			if (end === -1) continue;
			const body = src.slice(open + 1, end);
			// Top-level properties only: a nested `{ … }` or `(…)` belongs to a value, not the list.
			const props: string[] = [];
			let cur = '';
			depth = 0;
			for (const ch of body) {
				if ('([{'.includes(ch)) depth++;
				else if (')]}'.includes(ch)) depth--;
				if (ch === ',' && depth === 0) {
					props.push(cur);
					cur = '';
				} else cur += ch;
			}
			if (cur.trim()) props.push(cur);
			for (const p of props) {
				const colon = p.indexOf(':');
				const param = (colon === -1 ? p : p.slice(0, colon)).trim();
				const value = (colon === -1 ? p : p.slice(colon + 1)).trim().replace(/\s+/g, ' ');
				if (!/^[A-Za-z_$][\w$]*$/.test(param)) continue;
				const numeric = numericIdentifiers(value, vocab, rel(f));
				if (numeric.length)
					out.push({
						file: rel(f),
						line: src.slice(0, m.index!).split('\n').length,
						expr: value,
						numeric,
						key: m[1]!,
						param
					});
			}
		}
	}
	return out;
}
