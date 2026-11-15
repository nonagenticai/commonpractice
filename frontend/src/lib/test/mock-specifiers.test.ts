// Regression guard for the CI failure that killed all 31 tests in the four `src/lib/api/*.test.ts`
// files on three separate branches: a `vi.mock()` given a RELATIVE specifier can silently fail to
// register, because vitest 2.1 derives the importer it resolves against by parsing a stack trace
// truncated to five frames. An alias id needs no importer. The full mechanism is documented in the
// header of `src/lib/api/llm-settings.test.ts`.
//
// This guard is the only thing that stops the next person reintroducing it — the failure mode is
// invisible locally and only ever shows up in CI, on someone else's branch.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(process.cwd(), 'src');

// Assembled from fragments so this file never matches its own source text.
const RELATIVE_MOCK = new RegExp('vi' + '\\.mock\\(\\s*[\'"`]\\.\\.?/');

function testFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...testFiles(full));
		else if (entry.name.endsWith('.test.ts')) out.push(full);
	}
	return out;
}

describe('vi.mock specifiers', () => {
	it('finds the test files to scan (guards against a silently empty sweep)', () => {
		expect(testFiles(SRC).length).toBeGreaterThan(10);
	});

	it('are never relative — always the $lib alias id', () => {
		const offenders = testFiles(SRC)
			.filter((file) => RELATIVE_MOCK.test(readFileSync(file, 'utf8')))
			.map((file) => relative(process.cwd(), file));
		expect(offenders).toEqual([]);
	});
});
