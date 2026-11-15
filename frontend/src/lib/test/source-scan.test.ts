// src/lib/test/source-scan.test.ts — the stripper's own unit tests.
//
// A guard built on a stripper is only as strong as the stripper, and the whole point of this
// module is that the PREVIOUS guard was defeated by a comment. So the three comment forms are
// driven directly, and so is the one thing that must NOT be stripped.
import { describe, it, expect } from 'vitest';
import { stripComments, readRaw } from './source-scan';

describe('stripComments removes the three forms a Svelte file can hide a call in', () => {
	it('an HTML comment — evasion 1: the good call parked above a reverted line', () => {
		const src = `<!-- was: {m.pager_showing({ shown: num(shown, locale.current) })} -->
			{m.pager_showing({ shown, total })}`;
		const out = stripComments(src);
		expect(out).not.toContain('num(shown, locale.current)');
		expect(out).toContain('m.pager_showing({ shown, total })');
	});

	it('a multi-line HTML comment', () => {
		expect(stripComments('a\n<!-- one\ntwo\nthree -->\nb').replace(/\s+/g, ' ').trim()).toBe('a b');
	});

	it('a block comment — evasion 3: a faked `num(` and `locale.current` inside the argument list', () => {
		const src = '{ shown: String(shown) /* num( locale.current */, total: 1 }';
		const out = stripComments(src);
		expect(out).not.toContain('num(');
		expect(out).not.toContain('locale.current');
		expect(out).toContain('String(shown)');
	});

	it('a line comment', () => {
		expect(stripComments('const a = 1; // num(a, locale.current)\nconst b = 2;')).toBe(
			'const a = 1; \nconst b = 2;'
		);
	});

	it('a line comment at the very start of a line', () => {
		expect(stripComments('// num(x, locale.current)\nkeep')).toBe('\nkeep');
	});
});

describe('⛔ a comment state recognises ONLY its own terminator', () => {
	// THE MEASURED REGRESSION. `licenseGate.svelte.ts`'s header names the mock specifier `$app/*`
	// inside a `//` comment. A three-`.replace()` stripper strips block comments as its own pass,
	// sees that `/*`, and closes it at the first `*/` forty lines lower — swallowing every import
	// in the file. `not.toContain('$lib/paraglide')` over that output then reports GREEN for a file
	// that imports it on line 3.
	it('a `/*` inside a LINE comment does not open a block comment', () => {
		const src = "// the `$app/*` mock\nimport { getLocale } from '$lib/paraglide/runtime';\n/** doc */\nkeep";
		const out = stripComments(src);
		expect(out, 'the import was eaten by a comment that only mentioned `/*`').toContain(
			'$lib/paraglide/runtime'
		);
		expect(out).toContain('keep');
		expect(out).not.toContain('$app/*');
	});

	it('a `//` inside a BLOCK comment does not eat that block’s `*/`', () => {
		const out = stripComments('/* see // note */ const shown = num(shown, locale.current);');
		expect(out).toContain('num(shown, locale.current)');
		expect(out).not.toContain('note');
	});

	it('a `//` inside an HTML comment does not eat that comment’s `-->`', () => {
		const out = stripComments('<!-- todo // later --> {m.pager_showing({ shown, total })}');
		expect(out).toContain('m.pager_showing({ shown, total })');
		expect(out).not.toContain('later');
	});

	it('the real licenceGate store keeps its imports and its class', () => {
		// The regression above, driven against the actual file rather than a fixture.
		const out = stripComments(readRaw('lib/stores/licenseGate.svelte.ts'));
		expect(out).toContain("import { authFetch } from '$lib/api/auth-fetch';");
		expect(out).toContain('export class LicenseGate');
		expect(out, 'header prose survived the strip').not.toContain('mock occasionally');
	});
});

describe('⛔ …and does NOT eat the things that only look like comments', () => {
	it('a URL in a Svelte attribute survives — connectors/+page.svelte really ships three', () => {
		const src = '<input placeholder="postgres://user:pass@host:5432/db" />';
		expect(stripComments(src)).toBe(src);
		expect(stripComments('<input placeholder="https://api.example.com/rows.json" />')).toContain(
			'https://api.example.com/rows.json'
		);
	});

	it('an escaped slash pair inside a regex literal survives', () => {
		const src = 'if (/^(https?:)?\\/\\//i.test(url)) return;';
		expect(stripComments(src)).toBe(src);
	});

	it('code with no comments at all is returned byte-identical', () => {
		const src = '{m.pager_showing({ shown: num(shown, locale.current) })}';
		expect(stripComments(src)).toBe(src);
	});
});
