// src/routes/datasets/datasets-page.mapping-gate.test.ts — a TEXT guard: the dataset → ontology
// mapping EDITOR on /datasets renders only for a data manager (`canManage`).
//
// Why: a confirmed mapping to a non-PII attribute UNMASKS that column for every member
// (backend/src/datasets/member-view.ts). Since 2026-10-15 the backend refuses a member's
// `PUT`/`DELETE /api/datasets/:slug/mappings` with 403 (`requireDataManager`); this pins that the
// screen no longer offers a member controls that can only fail. Read-only saved mappings stay
// visible to everyone.
//
// ⚠️ This is a GREP over the template's block structure, not a render. It walks `{#…}` / `{:…}` /
// `{/…}` and asserts each editor control sits inside an `{#if canManage}` branch (not its `{:else}`).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAGE = fileURLToPath(new URL('./+page.svelte', import.meta.url));

/** The markup after the instance script, comments stripped. */
function markup(): string {
	const src = readFileSync(PAGE, 'utf-8');
	const end = src.indexOf('</script>');
	return src.slice(end).replace(/<!--[\s\S]*?-->/g, '');
}

/** For every occurrence of `needle`, whether an enclosing open block is `{#if canManage}` (in its
 *  then-branch). */
function gatedOccurrences(needle: string): boolean[] {
	const src = markup();
	const stack: string[] = [];
	const out: boolean[] = [];
	const re = /\{([#:/])([a-z]+)([^}]*)\}/g;
	let last = 0;
	let m: RegExpExecArray | null;
	const scan = (upTo: number) => {
		let i = src.indexOf(needle, last);
		while (i !== -1 && i < upTo) {
			out.push(stack.includes('if canManage'));
			i = src.indexOf(needle, i + needle.length);
		}
		last = upTo;
	};
	while ((m = re.exec(src))) {
		scan(m.index + 1);
		const [, kind, word, rest] = m;
		if (kind === '#') stack.push(`${word} ${rest!.trim()}`);
		else if (kind === ':') stack[stack.length - 1] = `${word}`;
		else stack.pop();
		last = m.index + m[0].length;
	}
	scan(src.length);
	return out;
}

describe('/datasets — the mapping editor is a data-manager control', () => {
	it('is the file we think it is (or every assertion below passes vacuously)', () => {
		const src = markup();
		expect(src.length).toBeGreaterThan(5000);
		expect(src).toContain('savedMappings');
	});

	for (const control of ['onclick={saveMappings}', 'removeMapping(', 'onclick={runSuggest}', 'setColMapping(', 'pickIndustry(']) {
		it(`${control} renders only under {#if canManage}`, () => {
			const hits = gatedOccurrences(control);
			expect(hits.length).toBeGreaterThan(0);
			expect(hits.every(Boolean)).toBe(true);
		});
	}

	// ⛔ CHANGED IN ROUND 2 (2026-10-15, member Library): this used to assert the saved mappings
	// stay readable for everyone. A saved mapping reads "column → entity attribute KEY", and the
	// owner's rule for a member's Library is no slugs and no attribute keys, so the whole mapping
	// section (heading, help, saved list, editor) now sits under `{#if canManage}`. A member still
	// sees the masked sample rows, which is what the mapping exists to serve.
	it('the saved mappings are a data-manager view too (attribute keys are not member copy)', () => {
		const hits = gatedOccurrences('{#each savedMappings as mp');
		expect(hits).toEqual([true]);
		expect(gatedOccurrences('m.datasets_mapping_title()')).toEqual([true]);
	});
});
