// @vitest-environment jsdom
//
// src/lib/components/marketplace/leaderboard-row.work-area.render.test.ts — the challenge surface
// names a work area in the reader's language, and keeps the enum for the wire.
//
// ⛔ THE DEFECT. `work_area` is a backend enum (`WORK_AREAS`, backend/src/routes/challenges.ts:33)
// and five sites printed it verbatim. The loudest is this row: /challenges renders the domain
// filter chip "Schadeclaims 12" and then, an inch below, twenty rows each reading "Claims". Home →
// Trending mounts the same component. The detail page repeated it four more times (badge, byline,
// "Getroffen medewerkers" sub-label, "Vergelijkbare uitdagingen").
//
// TWO GUARDS, because one component test cannot cover four sites in a 900-line route:
//   1. A DOM test on the row — the component people actually see twenty times per page.
//   2. A SOURCE scan for the exact four pre-fix expressions on the detail route. Blunt on purpose:
//      each pattern is byte-for-byte what was there before, so reverting any one site reddens this
//      file, and mounting `challenges/[id]` (SSE comments, datasets, cycle, ApiError) to assert one
//      text node would cost more than it proves.
//
// Assertions are on MESSAGE TOKENS: the mock resolves every catalog key to its own name, so a
// failure names the message the row CHOSE rather than copy a translator may reword.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChallengeRow } from '$lib/types/challenges';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync: read } = await import('node:fs');
	const { resolve: res } = await import('node:path');
	const catalog = JSON.parse(read(res(process.cwd(), 'messages/en.json'), 'utf8')) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			params && Object.keys(params).length ? `${key}:${Object.values(params).join(',')}` : key;
	}
	return mod;
});

import LeaderboardRow from './LeaderboardRow.svelte';

function makeRow(workArea: string): ChallengeRow {
	return {
		id: 'ch-1',
		code: 'CH-101',
		title: 'Claims intake takes four days',
		workArea,
		status: 'voting',
		week: '2026-W23',
		tags: [],
		votesCount: 42,
		rank: 1,
		hasVoted: false,
		solutionsCount: 0,
		submitter: { name: 'Ada Author', initials: 'AA' },
		createdAt: '2026-06-01T09:00:00.000Z'
	};
}

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

function render(workArea: string): HTMLElement {
	app = mount(LeaderboardRow, {
		target: host,
		props: { row: makeRow(workArea), cycle: null, onVote: () => {} }
	});
	flushSync();
	return host;
}

/** 1:1 with `WORK_AREAS` → the `domain_*` keys. Verified against the backend in work-area-label.test.ts. */
const EXPECTED: Record<string, string> = {
	Claims: 'domain_claims',
	Sales: 'domain_sales',
	Service: 'domain_service',
	Legal: 'domain_legal',
	Marketing: 'domain_marketing',
	Risk: 'domain_risk',
	Ops: 'domain_ops',
	IT: 'domain_it'
};

describe('a leaderboard row names its work area from the catalog, not from the enum', () => {
	for (const [enumValue, key] of Object.entries(EXPECTED)) {
		it(`${enumValue} renders ${key}`, () => {
			const el = render(enumValue);
			const meta = el.querySelector('.lb-meta')!.textContent!;
			expect(meta).toContain(key);
			// …and the enum itself is gone from the row's text. `IT` is a substring of nothing here,
			// but `Claims` is a substring of the fixture TITLE ("Claims intake takes four days") — so
			// this assertion is scoped to the meta line, which is where the defect was.
			expect(meta).not.toContain(enumValue);
		});
	}

	it('an off-list work area still renders as itself, not as a blank cell', () => {
		// Rows predating `z.enum(WORK_AREAS)` carry values like this; /challenges renders them as
		// `extraDomains` chips for exactly this reason. The row must degrade to the ugly word.
		const meta = render('Facilities').querySelector('.lb-meta')!.textContent!;
		expect(meta).toContain('Facilities');
	});
});

describe('challenges/[id] localizes all four of its work-area render sites', () => {
	const route = readFileSync(resolve(process.cwd(), 'src/routes/challenges/[id]/+page.svelte'), 'utf8');

	// The exact expressions that were on screen before the fix. Reverting any single site puts its
	// pattern back into the file.
	const REGRESSIONS: { site: string; re: RegExp }[] = [
		// Anchored between tags: a bare `/\{data\.workArea\}/` also matches the attribute form
		// `sub={data.workArea}` on the metric tile, which would make two of these four patterns fire
		// for one site and the failure message name the wrong line.
		{ site: 'the work-area badge under the title', re: />\s*\{\s*data\.workArea\s*\}\s*</ },
		{ site: 'the byline ("Sales · posted 3d ago")', re: /workArea:\s*data\.workArea\b/ },
		{ site: 'the "affected staff" metric sub-label', re: /sub=\{\s*data\.workArea\s*\}/ },
		{ site: 'the "similar challenges" list', re: /\{\s*s\.workArea\s*\}/ }
	];

	for (const { site, re } of REGRESSIONS) {
		it(`${site} does not print the raw enum`, () => {
			expect(re.test(route), `${site} renders \`work_area\` verbatim again`).toBe(false);
		});
	}

	it('…and the four patterns are the real pre-fix expressions, not regexes that match nothing', () => {
		// ⛔ NON-VACUITY. A source scan whose patterns never matched anything passes forever. These
		// are the literal strings this change replaced.
		const PRE_FIX = [
			'{#if data.workArea}<a class="badge work-area-link" href="…">{data.workArea}</a>{/if}',
			'{m.challenge_detail_posted({ workArea: data.workArea, ago: timeAgo(data.createdAt) })}',
			'<MetricTile label={m.challenge_detail_metric_affected_staff()} value={x} sub={data.workArea} />',
			'<span>{s.workArea} · {s.votesCount.toLocaleString()} ▲</span>'
		];
		for (const [i, sample] of PRE_FIX.entries()) {
			expect(REGRESSIONS[i]!.re.test(sample), `pattern ${i} does not match its own defect`).toBe(true);
		}
	});

	it('the deep-link keeps carrying the ENUM, not the translated word', () => {
		// ⛔ The other half of the fix, and the one that breaks filtering if someone "tidies" it:
		// /challenges resolves `?work_area=` with `DOMAINS.some((d) => d.v === wa)` and keys
		// `list.counts[…]` off the same literals. A localized query param deep-links to nothing.
		expect(route).toContain('href="/challenges?work_area={encodeURIComponent(data.workArea)}"');
		expect(route).not.toContain('encodeURIComponent(workAreaLabel(');
	});
});
